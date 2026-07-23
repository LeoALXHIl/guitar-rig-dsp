#include "PluginProcessor.h"

// ── voz 800-style (JCM800 2203), idêntica ao VOICES[0] do amp-processor.js ──
namespace v800
{
    static const double stageGain[3][2] = { {1.5, 9}, {1.5, 11}, {1.2, 6} };
    static const double bias[3]         = { 0.12, 0.08, 0.05 };
    static const double millerHz[3]     = { 9000, 11000, 10000 };
    static const double coupleHz[2]     = { 150, 60 };
    static const double midHz = 560, midQ = 0.7, midRangeLo = -13, midRangeHi = 5;
    static const double trebHz = 3000, bassHz = 100;
    static const double powerGain[2] = { 0.4, 4.5 };
    static const double sag = 0.6, xfmrResHz = 95, xfmrResGain = 3;
}

GuitarRigDSPAudioProcessor::GuitarRigDSPAudioProcessor()
    : juce::AudioProcessor (BusesProperties()
        .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
        .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "PARAMS", createLayout())
{
    pGain     = apvts.getRawParameterValue ("gain");
    pBass     = apvts.getRawParameterValue ("bass");
    pMid      = apvts.getRawParameterValue ("mid");
    pTreble   = apvts.getRawParameterValue ("treble");
    pPresence = apvts.getRawParameterValue ("presence");
    pDepth    = apvts.getRawParameterValue ("depth");
    pMaster   = apvts.getRawParameterValue ("master");
    pOutput   = apvts.getRawParameterValue ("output");
}

juce::AudioProcessorValueTreeState::ParameterLayout GuitarRigDSPAudioProcessor::createLayout()
{
    using P = juce::AudioParameterFloat;
    juce::AudioProcessorValueTreeState::ParameterLayout layout;
    auto range = juce::NormalisableRange<float> (0.0f, 1.0f, 0.001f);
    layout.add (std::make_unique<P> (juce::ParameterID{"gain",1},     "Preamp",   range, 0.7f));
    layout.add (std::make_unique<P> (juce::ParameterID{"bass",1},     "Bass",     range, 0.5f));
    layout.add (std::make_unique<P> (juce::ParameterID{"mid",1},      "Middle",   range, 0.55f));
    layout.add (std::make_unique<P> (juce::ParameterID{"treble",1},   "Treble",   range, 0.6f));
    layout.add (std::make_unique<P> (juce::ParameterID{"presence",1}, "Presence", range, 0.45f));
    layout.add (std::make_unique<P> (juce::ParameterID{"depth",1},    "Depth",    range, 0.35f));
    layout.add (std::make_unique<P> (juce::ParameterID{"master",1},   "Master",   range, 0.6f));
    layout.add (std::make_unique<P> (juce::ParameterID{"output",1},   "Output",   range, 0.7f));
    return layout;
}

void GuitarRigDSPAudioProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    fs = sampleRate;
    fsOS = sampleRate * (1 << OS_LOG2);   // 4×
    smA = (float) (1.0 - std::exp (-1.0 / (0.005 * fsOS)));

    auto nCh = (juce::uint32) juce::jmax (1, getTotalNumOutputChannels());
    oversampling = std::make_unique<juce::dsp::Oversampling<float>> (
        nCh, OS_LOG2, juce::dsp::Oversampling<float>::filterHalfBandPolyphaseIIR, true);
    oversampling->initProcessing ((size_t) samplesPerBlock);
    oversampling->reset();
    setLatencySamples ((int) oversampling->getLatencyInSamples());

    chans.assign ((size_t) nCh, Ch{});
    for (auto& c : chans) c.reset();
    sGain = pGain ? pGain->load() : 0.6f;
    sMaster = pMaster ? pMaster->load() : 0.6f;
}

bool GuitarRigDSPAudioProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    auto out = layouts.getMainOutputChannelSet();
    if (out != juce::AudioChannelSet::mono() && out != juce::AudioChannelSet::stereo())
        return false;
    return layouts.getMainInputChannelSet() == out;
}

void GuitarRigDSPAudioProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    const int totalIn = getTotalNumInputChannels(), totalOut = getTotalNumOutputChannels();
    for (int ch = totalIn; ch < totalOut; ++ch) buffer.clear (ch, 0, buffer.getNumSamples());

    const float gainT   = pGain ? pGain->load() : 0.6f;
    const float masterT = pMaster ? pMaster->load() : 0.6f;
    const float bass = pBass->load(), mid = pMid->load(), treble = pTreble->load();
    const float pres = pPresence->load(), depth = pDepth->load();
    const float outGain = pOutput ? pOutput->load() : 0.7f;

    // coeficientes fixos por bloco (à taxa 4×)
    const double aM[3] = { lpCoef (v800::millerHz[0], fsOS), lpCoef (v800::millerHz[1], fsOS), lpCoef (v800::millerHz[2], fsOS) };
    const double Rc0 = hpCoef (v800::coupleHz[0], fsOS), Rc1 = hpCoef (v800::coupleHz[1], fsOS);
    const double inHP = hpCoef (30.0, fsOS), xfmrHPr = hpCoef (24.0, fsOS);
    const double sagRelease = std::exp (-1.0 / (0.06 * fsOS));
    const double smile = (bass + treble) / 2.0;

    // tone stack / presence / depth por canal (recalcula por bloco)
    for (auto& c : chans)
    {
        c.bassF.lowShelf  (fsOS, v800::bassHz, lerp (-14, 8, bass));
        c.trebF.highShelf (fsOS, v800::trebHz, lerp (-8, 12, treble));
        c.midF.peaking    (fsOS, v800::midHz, v800::midQ, lerp (v800::midRangeLo, v800::midRangeHi, mid) - smile*3);
        c.presF.highShelf (fsOS, 2200.0, lerp (0, 10, pres));
        c.depthF.lowShelf (fsOS, 110.0, lerp (0, 9, depth));
        c.xfmrRes.peaking (fsOS, v800::xfmrResHz, 1.1, v800::xfmrResGain);
    }

    juce::dsp::AudioBlock<float> block (buffer);
    auto up = oversampling->processSamplesUp (block);
    const int nCh = juce::jmin ((int) up.getNumChannels(), (int) chans.size());
    const int nS  = (int) up.getNumSamples();

    for (int i = 0; i < nS; ++i)
    {
        // suaviza escalares uma vez por sample (compartilhado entre canais)
        sGain   += smA * (gainT - sGain);
        sMaster += smA * (masterT - sMaster);
        const double g0 = lerp (v800::stageGain[0][0], v800::stageGain[0][1], sGain);
        const double g1 = lerp (v800::stageGain[1][0], v800::stageGain[1][1], sGain);
        const double g2 = lerp (v800::stageGain[2][0], v800::stageGain[2][1], sGain);
        const double gs[3] = { g0, g1, g2 };
        const double pGainAmp = lerp (v800::powerGain[0], v800::powerGain[1], sMaster);

        for (int ch = 0; ch < nCh; ++ch)
        {
            float* d = up.getChannelPointer ((size_t) ch);
            Ch& c = chans[(size_t) ch];
            double s = highpass (d[i], c.dc, inHP);
            for (int st = 0; st < 3; ++st)
            {
                s = triode (s, gs[st], v800::bias[st]);
                c.miller[st] += aM[st] * (s - c.miller[st]); s = c.miller[st];
                if (st < 2) s = highpass (s, st == 0 ? c.cpl0 : c.cpl1, st == 0 ? Rc0 : Rc1);
            }
            s = c.bassF.process (s); s = c.midF.process (s); s = c.trebF.process (s);
            s = c.presF.process (s); s = c.depthF.process (s);
            double mag = s < 0 ? -s : s;
            c.sagEnv = mag > c.sagEnv ? mag : c.sagEnv * sagRelease;
            double sag = 1.0 / (1.0 + v800::sag * c.sagEnv);
            s = std::tanh (pGainAmp * sag * s);
            s = highpass (s, c.xfmrHP, xfmrHPr);
            s = c.xfmrRes.process (s);
            d[i] = (float) (s * 0.7 * outGain);
        }
    }

    oversampling->processSamplesDown (block);
}

void GuitarRigDSPAudioProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    if (auto xml = apvts.copyState().createXml())
        copyXmlToBinary (*xml, destData);
}

void GuitarRigDSPAudioProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    if (auto xml = getXmlFromBinary (data, sizeInBytes))
        if (xml->hasTagName (apvts.state.getType()))
            apvts.replaceState (juce::ValueTree::fromXml (*xml));
}

// fábrica do plugin (exigida pelo JUCE)
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new GuitarRigDSPAudioProcessor();
}
