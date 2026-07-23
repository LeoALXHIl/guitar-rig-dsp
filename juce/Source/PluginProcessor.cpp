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

    // ── Cabinet: CABS / SPEAKERS / MICS (idênticos ao makeCabMicIR do web) ──
    struct CabModel { double hp, resHz, resGain; };
    const CabModel CABS[3] = { {78,85,6}, {85,100,5}, {95,120,4} };   // 4x12, 2x12, 1x12
    struct SpeakerModel { double bodyHz, bodyGain, presHz, presGain, topHz; int nBreak; double breakup[5][3]; };
    const SpeakerModel SPEAKERS[3] = {
        { 480,-3, 2600,6, 5200, 5, {{1500,1.8,3},{2100,2.2,-4},{2900,2.5,5},{3800,2.2,-3},{4600,2.0,2}} }, // v30
        { 520, 4, 1800,2, 4400, 4, {{1400,1.6,2},{2200,2.0,-2},{3000,2.0,2},{3900,1.8,-3},{0,0,0}} },      // green
        { 500, 1, 2200,4, 4900, 4, {{1600,1.8,2},{2400,2.2,3},{3300,2.2,-3},{4400,2.0,2},{0,0,0}} },       // cream
    };
    struct MicModel { int nPk; double pk[2][3]; double shelfHz, shelfGain, topHz; };
    const MicModel MICS[3] = {
        { 2, {{5500,1.0,5},{3000,0.8,2}}, 120,-2, 6500 },   // sm57
        { 2, {{8000,0.9,3},{4500,0.8,2}},  90, 2, 9000 },   // md421
        { 1, {{2000,0.7,2},{0,0,0}},      100, 3, 3800 },   // r121
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
    pCabOn    = apvts.getRawParameterValue ("cabOn");
    pCab      = apvts.getRawParameterValue ("cab");
    pSpeaker  = apvts.getRawParameterValue ("speaker");
    pMic      = apvts.getRawParameterValue ("mic");
    pAxis     = apvts.getRawParameterValue ("axis");
    pDistance = apvts.getRawParameterValue ("distance");
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

    layout.add (std::make_unique<juce::AudioParameterBool>   (juce::ParameterID{"cabOn",1}, "Cab On", true));
    layout.add (std::make_unique<juce::AudioParameterChoice> (juce::ParameterID{"cab",1}, "Cabinet",
        juce::StringArray { "4x12", "2x12", "1x12" }, 0));
    layout.add (std::make_unique<juce::AudioParameterChoice> (juce::ParameterID{"speaker",1}, "Speaker",
        juce::StringArray { "V30", "Greenback", "Creamback" }, 0));
    layout.add (std::make_unique<juce::AudioParameterChoice> (juce::ParameterID{"mic",1}, "Mic",
        juce::StringArray { "SM57", "MD421", "R121" }, 0));
    layout.add (std::make_unique<PF> (juce::ParameterID{"axis",1},     "Mic Axis",     range, 0.25f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"distance",1}, "Mic Distance", range, 0.30f));
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

    // ── cabinet (Sprint 1): coeficientes por bloco (à taxa 4×) ──
    const bool cabOn = pCabOn ? pCabOn->load() > 0.5f : true;
    const int cabIdx = juce::jlimit (0, 2, (int) std::lround (pCab ? pCab->load() : 0.0f));
    const int spkIdx = juce::jlimit (0, 2, (int) std::lround (pSpeaker ? pSpeaker->load() : 0.0f));
    const int micIdx = juce::jlimit (0, 2, (int) std::lround (pMic ? pMic->load() : 0.0f));
    const double axis = pAxis ? pAxis->load() : 0.25, dist = pDistance ? pDistance->load() : 0.3;
    const CabModel& CB = CABS[cabIdx]; const SpeakerModel& SP = SPEAKERS[spkIdx]; const MicModel& MC = MICS[micIdx];
    const double axisTop = 8000.0 - axis * 5500.0;
    const double cabLPf  = juce::jmax (500.0, juce::jmin (juce::jmin (SP.topHz, MC.topHz), axisTop));
    const double combDelay = (0.08 + dist * 0.5) / 1000.0 * fsOS;
    const double combGain  = -0.4 * (0.25 + dist * 0.75);
    if (cabOn)
        for (auto& c : chans)
        {
            c.cHP.highpass  (fsOS, CB.hp, 0.7);
            c.cRes.peaking  (fsOS, CB.resHz, 1.1, CB.resGain + (1.0 - dist) * 2.0);
            c.cBody.peaking (fsOS, SP.bodyHz, 1.0, SP.bodyGain);
            c.cPres.peaking (fsOS, SP.presHz, 1.2, SP.presGain);
            c.nBreak = SP.nBreak;
            for (int b = 0; b < SP.nBreak; ++b) c.cBreak[b].peaking (fsOS, SP.breakup[b][0], SP.breakup[b][1], SP.breakup[b][2]);
            c.nMicPk = MC.nPk;
            for (int b = 0; b < MC.nPk; ++b) c.cMicPk[b].peaking (fsOS, MC.pk[b][0], MC.pk[b][1], MC.pk[b][2]);
            c.cShelf.lowShelf (fsOS, MC.shelfHz, MC.shelfGain);
            c.cLP.lowpass (fsOS, cabLPf, 0.8);
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
            if (cabOn)
            {
                s = c.cHP.process (s); s = c.cRes.process (s); s = c.cBody.process (s); s = c.cPres.process (s);
                for (int b = 0; b < c.nBreak; ++b) s = c.cBreak[b].process (s);
                for (int b = 0; b < c.nMicPk; ++b) s = c.cMicPk[b].process (s);
                s = c.cShelf.process (s); s = c.cLP.process (s);
                double rp = c.combW - combDelay; while (rp < 0) rp += 2048.0;
                int i0 = (int) rp; double frac = rp - i0;
                double a0 = c.comb[i0 & 2047], a1 = c.comb[(i0 + 1) & 2047];
                double delayed = a0 + (a1 - a0) * frac;
                c.comb[c.combW] = s; c.combW = (c.combW + 1) & 2047;
                s = (s + combGain * delayed) * 1.4;   // makeup leve p/ compensar o rolloff do cab
            }
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
