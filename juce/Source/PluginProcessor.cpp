#include "PluginProcessor.h"

// ── VOICES: idênticas ao amp-processor.js do web (4 amps + canais) ──
namespace
{
    struct Channel { double gainMul; int stages; };
    struct Voice
    {
        double stageGain[4][2];
        double bias[4];
        double millerHz[4];
        double millerBrightHz;
        double coupleHz[2];
        double coupleBrightHz;
        double midHz, midQ, midRangeLo, midRangeHi, trebHz, bassHz;
        double powerGain[2], sag, xfmrResHz, xfmrResGain;
        int numChannels;
        Channel channels[3];
    };

    const Voice VOICES[4] = {
        // 0 — 800-style (JCM800 2203)
        { {{1.5,9},{1.5,11},{1.2,6},{1.2,6}}, {0.12,0.08,0.05,0.05}, {9000,11000,10000,10000}, 15000,
          {150,60}, 260, 560,0.7,-13,5, 3000,100, {0.4,4.5},0.6,95,3, 1, {{1.0,3},{1.0,3},{1.0,3}} },
        // 1 — 5150-style (EVH 5150III)
        { {{2,12},{2,13},{1.6,9},{1.3,6}}, {0.14,0.10,0.06,0.04}, {6000,7000,6000,6000}, 9000,
          {220,120}, 340, 650,0.8,-16,3, 3200,90, {0.4,4.0},0.35,85,4, 3, {{0.20,2},{0.52,3},{1.0,4}} },
        // 2 — Clean US (Twin)
        { {{1.2,3.6},{1.0,2.6},{1.0,2.0},{1.0,2.0}}, {0.06,0.04,0.03,0.03}, {12000,12000,12000,12000}, 16000,
          {80,40}, 180, 500,0.7,-10,3, 4000,90, {0.3,3.0},0.15,100,2, 1, {{1.0,2},{1.0,2},{1.0,2}} },
        // 3 — Rectifier-style Modern
        { {{2.2,14},{2.2,15},{1.8,11},{1.5,8}}, {0.16,0.11,0.07,0.05}, {5000,5500,5000,5000}, 8000,
          {180,100}, 300, 700,0.9,-18,2, 3500,85, {0.4,4.2},0.5,80,4, 2, {{0.72,3},{1.0,4},{1.0,4}} },
    };
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
    pModel    = apvts.getRawParameterValue ("model");
    pChannel  = apvts.getRawParameterValue ("channel");
    pBright   = apvts.getRawParameterValue ("bright");
}

juce::AudioProcessorValueTreeState::ParameterLayout GuitarRigDSPAudioProcessor::createLayout()
{
    using PF = juce::AudioParameterFloat;
    juce::AudioProcessorValueTreeState::ParameterLayout layout;
    auto range = juce::NormalisableRange<float> (0.0f, 1.0f, 0.001f);

    layout.add (std::make_unique<juce::AudioParameterChoice> (juce::ParameterID{"model",1}, "Amp",
        juce::StringArray { "800-style", "5150-style", "Clean US (Twin)", "Rectifier" }, 0));
    layout.add (std::make_unique<juce::AudioParameterInt> (juce::ParameterID{"channel",1}, "Channel", 0, 2, 0));
    layout.add (std::make_unique<juce::AudioParameterBool> (juce::ParameterID{"bright",1}, "Bright", true));

    layout.add (std::make_unique<PF> (juce::ParameterID{"gain",1},     "Gain",     range, 0.7f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"bass",1},     "Bass",     range, 0.5f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"mid",1},      "Mid",      range, 0.55f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"treble",1},   "Treble",   range, 0.6f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"presence",1}, "Presence", range, 0.45f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"depth",1},    "Depth/Resonance", range, 0.35f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"master",1},   "Master",   range, 0.6f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"output",1},   "Output",   range, 0.7f));
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

    // ── seleção de amp + canal ──
    int model = pModel ? (int) std::lround (pModel->load()) : 0;
    model = juce::jlimit (0, 3, model);
    const Voice& V = VOICES[model];
    int chIdx = pChannel ? (int) std::lround (pChannel->load()) : 0;
    chIdx = juce::jlimit (0, V.numChannels - 1, chIdx);
    const Channel& CHN = V.channels[chIdx];
    const int nStages = CHN.stages;
    const bool bright = pBright ? (pBright->load() > 0.5f) : true;

    const float gainT   = (pGain ? pGain->load() : 0.6f) * (float) CHN.gainMul;
    const float masterT = pMaster ? pMaster->load() : 0.6f;
    const float bass = pBass->load(), mid = pMid->load(), treble = pTreble->load();
    const float pres = pPresence->load(), depth = pDepth->load();
    const float outGain = pOutput ? pOutput->load() : 0.7f;

    // coeficientes fixos por bloco (à taxa 4×)
    double aM[4];
    for (int st = 0; st < 4; ++st)
        aM[st] = lpCoef ((st == 0 && bright) ? V.millerBrightHz : V.millerHz[st], fsOS);
    const double Rc0 = hpCoef (bright ? V.coupleBrightHz : V.coupleHz[0], fsOS);
    const double Rc1 = hpCoef (V.coupleHz[1], fsOS);
    const double inHP = hpCoef (30.0, fsOS), xfmrHPr = hpCoef (24.0, fsOS);
    const double sagRelease = std::exp (-1.0 / (0.06 * fsOS));
    const double smile = (bass + treble) / 2.0;

    for (auto& c : chans)
    {
        c.bassF.lowShelf  (fsOS, V.bassHz, lerp (-14, 8, bass));
        c.trebF.highShelf (fsOS, V.trebHz, lerp (-8, 12, treble));
        c.midF.peaking    (fsOS, V.midHz, V.midQ, lerp (V.midRangeLo, V.midRangeHi, mid) - smile*3);
        c.presF.highShelf (fsOS, 2200.0, lerp (0, 10, pres));
        c.depthF.lowShelf (fsOS, 110.0, lerp (0, 9, depth));
        c.xfmrRes.peaking (fsOS, V.xfmrResHz, 1.1, V.xfmrResGain);
    }

    juce::dsp::AudioBlock<float> block (buffer);
    auto up = oversampling->processSamplesUp (block);
    const int nCh = juce::jmin ((int) up.getNumChannels(), (int) chans.size());
    const int nS  = (int) up.getNumSamples();

    for (int i = 0; i < nS; ++i)
    {
        sGain   += smA * (gainT - sGain);
        sMaster += smA * (masterT - sMaster);
        double gs[4];
        for (int st = 0; st < 4; ++st) gs[st] = lerp (V.stageGain[st][0], V.stageGain[st][1], sGain);
        const double pGainAmp = lerp (V.powerGain[0], V.powerGain[1], sMaster);

        for (int ch = 0; ch < nCh; ++ch)
        {
            float* d = up.getChannelPointer ((size_t) ch);
            Ch& c = chans[(size_t) ch];
            double s = highpass (d[i], c.dc, inHP);
            for (int st = 0; st < nStages; ++st)
            {
                s = triode (s, gs[st], V.bias[st]);
                c.miller[st] += aM[st] * (s - c.miller[st]); s = c.miller[st];
                if (st < 2) s = highpass (s, st == 0 ? c.cpl0 : c.cpl1, st == 0 ? Rc0 : Rc1);
            }
            s = c.bassF.process (s); s = c.midF.process (s); s = c.trebF.process (s);
            s = c.presF.process (s); s = c.depthF.process (s);
            double mag = s < 0 ? -s : s;
            c.sagEnv = mag > c.sagEnv ? mag : c.sagEnv * sagRelease;
            double sag = 1.0 / (1.0 + V.sag * c.sagEnv);
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

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new GuitarRigDSPAudioProcessor();
}
