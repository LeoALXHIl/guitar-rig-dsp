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
    pOdOn = apvts.getRawParameterValue ("odOn"); pOdDrive = apvts.getRawParameterValue ("odDrive");
    pOdTone = apvts.getRawParameterValue ("odTone"); pOdLevel = apvts.getRawParameterValue ("odLevel");
    pFzOn = apvts.getRawParameterValue ("fzOn"); pFzSustain = apvts.getRawParameterValue ("fzSustain");
    pFzTone = apvts.getRawParameterValue ("fzTone"); pFzLevel = apvts.getRawParameterValue ("fzLevel");
    pGateOn = apvts.getRawParameterValue ("gateOn"); pGateThr = apvts.getRawParameterValue ("gateThr"); pGateRel = apvts.getRawParameterValue ("gateRel");
    pCompOn = apvts.getRawParameterValue ("compOn"); pCompThr = apvts.getRawParameterValue ("compThr");
    pCompRatio = apvts.getRawParameterValue ("compRatio"); pCompMakeup = apvts.getRawParameterValue ("compMakeup");
    pEqOn = apvts.getRawParameterValue ("eqOn"); pEqLow = apvts.getRawParameterValue ("eqLow");
    pEqMid = apvts.getRawParameterValue ("eqMid"); pEqHigh = apvts.getRawParameterValue ("eqHigh");
    pEqMidFreq = apvts.getRawParameterValue ("eqMidFreq"); pEqMidQ = apvts.getRawParameterValue ("eqMidQ");
    pEqHP = apvts.getRawParameterValue ("eqHP"); pEqLP = apvts.getRawParameterValue ("eqLP");
    pDlyOn = apvts.getRawParameterValue ("dlyOn"); pDlyTime = apvts.getRawParameterValue ("dlyTime");
    pDlyFb = apvts.getRawParameterValue ("dlyFb"); pDlyTone = apvts.getRawParameterValue ("dlyTone"); pDlyMix = apvts.getRawParameterValue ("dlyMix");
    pRvOn = apvts.getRawParameterValue ("rvOn"); pRvSize = apvts.getRawParameterValue ("rvSize");
    pRvDamp = apvts.getRawParameterValue ("rvDamp"); pRvMix = apvts.getRawParameterValue ("rvMix");
    pChoOn = apvts.getRawParameterValue ("choOn"); pChoRate = apvts.getRawParameterValue ("choRate");
    pChoDepth = apvts.getRawParameterValue ("choDepth"); pChoMix = apvts.getRawParameterValue ("choMix");
    pPhOn = apvts.getRawParameterValue ("phOn"); pPhRate = apvts.getRawParameterValue ("phRate");
    pPhDepth = apvts.getRawParameterValue ("phDepth"); pPhFb = apvts.getRawParameterValue ("phFb"); pPhMix = apvts.getRawParameterValue ("phMix");
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

    // Overdrive (pré-amp)
    layout.add (std::make_unique<juce::AudioParameterBool> (juce::ParameterID{"odOn",1}, "OD On", false));
    layout.add (std::make_unique<PF> (juce::ParameterID{"odDrive",1}, "OD Drive", juce::NormalisableRange<float>(1.0f,100.0f,1.0f), 8.0f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"odTone",1},  "OD Tone",  range, 0.6f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"odLevel",1}, "OD Level", range, 0.5f));
    // Fuzz (pré-amp)
    layout.add (std::make_unique<juce::AudioParameterBool> (juce::ParameterID{"fzOn",1}, "Fuzz On", false));
    layout.add (std::make_unique<PF> (juce::ParameterID{"fzSustain",1}, "Fuzz Sustain", range, 0.6f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"fzTone",1},    "Fuzz Tone",    range, 0.5f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"fzLevel",1},   "Fuzz Level",   range, 0.6f));
    // Noise Gate (frente)
    layout.add (std::make_unique<juce::AudioParameterBool> (juce::ParameterID{"gateOn",1}, "Gate On", false));
    layout.add (std::make_unique<PF> (juce::ParameterID{"gateThr",1}, "Gate Thresh", juce::NormalisableRange<float>(-90.0f,0.0f,0.1f), -60.0f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"gateRel",1}, "Gate Release", juce::NormalisableRange<float>(10.0f,600.0f,1.0f), 120.0f));
    // Compressor (frente)
    layout.add (std::make_unique<juce::AudioParameterBool> (juce::ParameterID{"compOn",1}, "Comp On", false));
    layout.add (std::make_unique<PF> (juce::ParameterID{"compThr",1},   "Comp Thresh", juce::NormalisableRange<float>(-60.0f,0.0f,0.1f), -24.0f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"compRatio",1}, "Comp Ratio",  juce::NormalisableRange<float>(1.0f,20.0f,0.1f), 4.0f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"compMakeup",1},"Comp Makeup", juce::NormalisableRange<float>(0.0f,24.0f,0.1f), 0.0f));
    // EQ paramétrico (pós-cab)
    layout.add (std::make_unique<juce::AudioParameterBool> (juce::ParameterID{"eqOn",1}, "EQ On", false));
    layout.add (std::make_unique<PF> (juce::ParameterID{"eqLow",1},  "EQ Low",  juce::NormalisableRange<float>(-18.0f,18.0f,0.1f), 0.0f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"eqMid",1},  "EQ Mid",  juce::NormalisableRange<float>(-18.0f,18.0f,0.1f), 0.0f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"eqHigh",1}, "EQ High", juce::NormalisableRange<float>(-18.0f,18.0f,0.1f), 0.0f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"eqMidFreq",1}, "EQ Mid Freq", juce::NormalisableRange<float>(200.0f,5000.0f,1.0f,0.35f), 800.0f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"eqMidQ",1},    "EQ Mid Q",    juce::NormalisableRange<float>(0.2f,8.0f,0.01f), 1.0f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"eqHP",1},  "EQ HighPass", juce::NormalisableRange<float>(20.0f,400.0f,1.0f,0.4f), 20.0f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"eqLP",1},  "EQ LowPass",  juce::NormalisableRange<float>(2000.0f,20000.0f,1.0f,0.4f), 20000.0f));
    // Delay
    layout.add (std::make_unique<juce::AudioParameterBool> (juce::ParameterID{"dlyOn",1}, "Delay On", false));
    layout.add (std::make_unique<PF> (juce::ParameterID{"dlyTime",1}, "Delay Time", juce::NormalisableRange<float>(0.02f,1.2f,0.001f,0.4f), 0.35f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"dlyFb",1},   "Delay Feedback", juce::NormalisableRange<float>(0.0f,0.95f,0.001f), 0.35f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"dlyTone",1}, "Delay Tone", range, 0.5f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"dlyMix",1},  "Delay Mix",  range, 0.3f));
    // Reverb
    layout.add (std::make_unique<juce::AudioParameterBool> (juce::ParameterID{"rvOn",1}, "Reverb On", false));
    layout.add (std::make_unique<PF> (juce::ParameterID{"rvSize",1}, "Reverb Size", range, 0.6f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"rvDamp",1}, "Reverb Damp", range, 0.5f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"rvMix",1},  "Reverb Mix",  range, 0.25f));
    // Chorus
    layout.add (std::make_unique<juce::AudioParameterBool> (juce::ParameterID{"choOn",1}, "Chorus On", false));
    layout.add (std::make_unique<PF> (juce::ParameterID{"choRate",1},  "Chorus Rate",  range, 0.3f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"choDepth",1}, "Chorus Depth", range, 0.5f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"choMix",1},   "Chorus Mix",   range, 0.5f));
    // Phaser
    layout.add (std::make_unique<juce::AudioParameterBool> (juce::ParameterID{"phOn",1}, "Phaser On", false));
    layout.add (std::make_unique<PF> (juce::ParameterID{"phRate",1},  "Phaser Rate",  range, 0.3f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"phDepth",1}, "Phaser Depth", range, 0.7f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"phFb",1},    "Phaser Feedback", juce::NormalisableRange<float>(0.0f,0.9f,0.001f), 0.3f));
    layout.add (std::make_unique<PF> (juce::ParameterID{"phMix",1},   "Phaser Mix",   range, 0.5f));
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

    // buffers dos efeitos de tempo (delay/chorus/reverb) por canal
    static const int combTun[8] = { 1116,1188,1277,1356,1422,1491,1557,1617 };
    static const int apTun[4]   = { 556,441,341,225 };
    const double rvScale = sampleRate / 44100.0;
    const int dlyLen = (int) (sampleRate * 1.3) + 4;
    const int choLen = (int) (sampleRate * 0.05) + 4;
    for (size_t ci = 0; ci < chans.size(); ++ci)
    {
        auto& c = chans[ci];
        const int spread = (ci == 1) ? 23 : 0;   // stereospread do Freeverb (largura L/R)
        c.dlyBuf.assign ((size_t) dlyLen, 0.0f); c.dlyW = 0; c.dlyToneLp = 0;
        c.choBuf.assign ((size_t) choLen, 0.0f); c.choW = 0; c.choPhase = 0;
        for (int k = 0; k < 8; ++k) { c.combBuf[k].assign ((size_t) ((int) (combTun[k] * rvScale) + spread + 1), 0.0f); c.combI[k] = 0; c.combF[k] = 0; }
        for (int k = 0; k < 4; ++k) { c.apBuf[k].assign   ((size_t) ((int) (apTun[k]   * rvScale) + spread + 1), 0.0f); c.apI[k] = 0; }
        for (int k = 0; k < 6; ++k) c.phZ[k] = 0; c.phFb = 0; c.phPhase = 0;
    }
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

    // ── Overdrive / Fuzz (Sprints 7-8): coeficientes por bloco (à taxa 4×) ──
    const bool odOn = pOdOn && pOdOn->load() > 0.5f;
    const double odDrive = pOdDrive ? pOdDrive->load() : 8.0;
    const double odTone  = pOdTone ? pOdTone->load() : 0.6;
    const double odLevel = pOdLevel ? pOdLevel->load() : 0.5;
    const double odBias = 0.18, odBiasComp = std::tanh (0.18);
    const double odA = lpCoef (juce::jmin (700.0 * std::pow (10.0, odTone), fsOS * 0.45), fsOS);
    const bool fzOn = pFzOn && pFzOn->load() > 0.5f;
    const double fzSustain = pFzSustain ? pFzSustain->load() : 0.6;
    const double fzTone  = pFzTone ? pFzTone->load() : 0.5;
    const double fzLevel = pFzLevel ? pFzLevel->load() : 0.6;
    const double fzDcR   = hpCoef (25.0, fsOS);
    const double fzMidA  = lpCoef (6500.0, fsOS);
    const double fzToneA = lpCoef (700.0 * std::pow (10.0, fzTone * 0.8), fsOS);
    const double fzPre = 4.0 + fzSustain * 86.0, fzB = std::tanh (0.05);

    // ── Gate + Compressor (Sprints 9-10): base rate, ANTES do oversampling ──
    const bool gateOn = pGateOn && pGateOn->load() > 0.5f;
    const double gThr = std::pow (10.0, (pGateThr ? pGateThr->load() : -60.0) / 20.0);
    const double gRel = std::exp (-1.0 / (((pGateRel ? pGateRel->load() : 120.0) / 1000.0) * fs));
    const bool compOn = pCompOn && pCompOn->load() > 0.5f;
    const double cThr = std::pow (10.0, (pCompThr ? pCompThr->load() : -24.0) / 20.0);
    const double cRatio = pCompRatio ? pCompRatio->load() : 4.0;
    const double cMakeup = std::pow (10.0, (pCompMakeup ? pCompMakeup->load() : 0.0) / 20.0);
    const double cAtt = std::exp (-1.0 / (0.005 * fs)), cRel = std::exp (-1.0 / (0.12 * fs));
    if (gateOn || compOn)
    {
        const int nb = juce::jmin (getTotalNumInputChannels(), (int) chans.size());
        for (int ch = 0; ch < nb; ++ch)
        {
            float* d = buffer.getWritePointer (ch);
            Ch& c = chans[(size_t) ch];
            for (int i = 0; i < buffer.getNumSamples(); ++i)
            {
                double x = d[i];
                if (gateOn) { double lvl = std::abs (x); c.gateEnv = lvl > c.gateEnv ? lvl : lvl + (c.gateEnv - lvl) * gRel;
                              double g = c.gateEnv >= gThr ? 1.0 : c.gateEnv / gThr; x *= g * g; }
                if (compOn) { double lvl = std::abs (x); double co = lvl > c.compEnv ? cAtt : cRel; c.compEnv = lvl + (c.compEnv - lvl) * co;
                              double over = c.compEnv / cThr; double g = over > 1.0 ? std::pow (over, 1.0 / cRatio - 1.0) : 1.0; x *= g * cMakeup; }
                d[i] = (float) x;
            }
        }
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
            double x0 = d[i];
            if (odOn) {                                   // Overdrive (tube screamer)
                double sd = std::tanh (x0 * odDrive + odBias) - odBiasComp;
                c.odLp += odA * (sd - c.odLp); sd = c.odLp;
                x0 = sd * odLevel;
            }
            if (fzOn) {                                   // Fuzz (Big Muff)
                double f = highpass (x0, c.fzDc, fzDcR);
                f = std::tanh (fzPre * f + 0.05) - fzB;
                c.fzMid += fzMidA * (f - c.fzMid); f = c.fzMid;
                f = std::tanh (1.8 * f);
                c.fzToneLp += fzToneA * (f - c.fzToneLp);
                double lp = c.fzToneLp, hp = f - c.fzToneLp;
                f = lp * (1.0 - fzTone) + hp * fzTone;
                x0 = f * (0.15 + fzLevel * 0.85);
            }
            double s = highpass (x0, c.dc, inHP);
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

    // ── EQ paramétrico (Sprint 11): base rate, PÓS-cab ──
    if (pEqOn && pEqOn->load() > 0.5f)
    {
        const double lowDb = pEqLow->load(), midDb = pEqMid->load(), highDb = pEqHigh->load();
        const double midF = pEqMidFreq->load(), midQ = pEqMidQ->load(), hpF = pEqHP->load(), lpF = pEqLP->load();
        for (auto& c : chans)
        {
            c.eqHP.highpass   (fs, hpF, 0.7);
            c.eqLowF.lowShelf (fs, 120.0, lowDb);
            c.eqMidF.peaking  (fs, midF, midQ, midDb);
            c.eqHighF.highShelf (fs, 3500.0, highDb);
            c.eqLP.lowpass    (fs, juce::jmin (lpF, fs * 0.45), 0.7);
        }
        const int nb = juce::jmin (getTotalNumOutputChannels(), (int) chans.size());
        for (int ch = 0; ch < nb; ++ch)
        {
            float* d = buffer.getWritePointer (ch);
            Ch& c = chans[(size_t) ch];
            for (int i = 0; i < buffer.getNumSamples(); ++i)
            {
                double x = d[i];
                x = c.eqHP.process (x); x = c.eqLowF.process (x); x = c.eqMidF.process (x);
                x = c.eqHighF.process (x); x = c.eqLP.process (x);
                d[i] = (float) x;
            }
        }
    }

    // ── Tempo/modulação (Sprints 12-14): base rate, pós-EQ → Chorus → Phaser → Delay → Reverb ──
    const bool choOn = pChoOn && pChoOn->load() > 0.5f;
    const bool phOn  = pPhOn  && pPhOn->load()  > 0.5f;
    const bool dlyOn = pDlyOn && pDlyOn->load() > 0.5f;
    const bool rvOn  = pRvOn  && pRvOn->load()  > 0.5f;
    if (choOn || phOn || dlyOn || rvOn)
    {
        const double choRate = 0.1 + (pChoRate ? pChoRate->load() : 0.3) * 5.9;
        const double choDepth = (pChoDepth ? pChoDepth->load() : 0.5) * 0.005 * fs;
        const double choBase = 0.008 * fs, choMix = pChoMix ? pChoMix->load() : 0.5;
        const double choInc = 2.0 * M_PI * choRate / fs;
        const double phRate = 0.05 + (pPhRate ? pPhRate->load() : 0.3) * 3.95;
        const double phDepth = pPhDepth ? pPhDepth->load() : 0.7, phFbAmt = pPhFb ? pPhFb->load() : 0.3, phMix = pPhMix ? pPhMix->load() : 0.5;
        const double phInc = 2.0 * M_PI * phRate / fs;
        const double dlySamp = (pDlyTime ? pDlyTime->load() : 0.35) * fs;
        const double dlyFb = pDlyFb ? pDlyFb->load() : 0.35, dlyMix = pDlyMix ? pDlyMix->load() : 0.3;
        const double dlyToneA = lpCoef (juce::jmin (500.0 * std::pow (10.0, (pDlyTone ? pDlyTone->load() : 0.5)), fs * 0.45), fs);
        const double rvFb = (pRvSize ? pRvSize->load() : 0.6) * 0.28 + 0.7, rvDamp = (pRvDamp ? pRvDamp->load() : 0.5) * 0.4, rvMix = pRvMix ? pRvMix->load() : 0.25;
        const int nb = juce::jmin (getTotalNumOutputChannels(), (int) chans.size());
        for (int ch = 0; ch < nb; ++ch)
        {
            float* d = buffer.getWritePointer (ch);
            Ch& c = chans[(size_t) ch];
            const double lfoOff = (ch == 1) ? M_PI / 2 : 0.0;
            const int dN = (int) c.dlyBuf.size(), cN = (int) c.choBuf.size();
            for (int i = 0; i < buffer.getNumSamples(); ++i)
            {
                double x = d[i];
                if (choOn && cN > 8) {
                    double lfo = std::sin (c.choPhase + lfoOff);
                    double dd = choBase + choDepth * (0.5 + 0.5 * lfo);
                    double rpos = c.choW - dd; while (rpos < 0) rpos += cN;
                    int i0 = (int) rpos; double fr = rpos - i0;
                    double wet = c.choBuf[i0 % cN] + (c.choBuf[(i0 + 1) % cN] - c.choBuf[i0 % cN]) * fr;
                    c.choBuf[c.choW] = (float) x; c.choW = (c.choW + 1) % cN;
                    c.choPhase += choInc; if (c.choPhase > 2 * M_PI) c.choPhase -= 2 * M_PI;
                    x = x * (1.0 - choMix * 0.5) + wet * choMix;
                }
                if (phOn) {
                    double lfo = std::sin (c.phPhase + lfoOff);
                    double f = 300.0 * std::pow (2300.0 / 300.0, 0.5 + 0.5 * lfo * phDepth);
                    double tw = std::tan (M_PI * juce::jmin (f, fs * 0.45) / fs);
                    double g = (tw - 1.0) / (tw + 1.0);
                    double s = x + phFbAmt * c.phFb;
                    for (int k = 0; k < 6; ++k) { double y = g * s + c.phZ[k]; c.phZ[k] = s - g * y; s = y; }
                    c.phFb = s;
                    c.phPhase += phInc; if (c.phPhase > 2 * M_PI) c.phPhase -= 2 * M_PI;
                    x = x * (1.0 - phMix) + s * phMix;
                }
                if (dlyOn && dN > 8) {
                    double rpos = c.dlyW - dlySamp; while (rpos < 0) rpos += dN;
                    int i0 = (int) rpos; double fr = rpos - i0;
                    double rd = c.dlyBuf[i0 % dN] + (c.dlyBuf[(i0 + 1) % dN] - c.dlyBuf[i0 % dN]) * fr;
                    c.dlyToneLp += dlyToneA * (rd - c.dlyToneLp); double rdT = c.dlyToneLp;
                    c.dlyBuf[c.dlyW] = (float) (x + rdT * dlyFb); c.dlyW = (c.dlyW + 1) % dN;
                    x = x * (1.0 - dlyMix) + rdT * dlyMix;
                }
                if (rvOn) {
                    double input = x * 0.015, out = 0.0;
                    for (int k = 0; k < 8; ++k) {
                        int n = (int) c.combBuf[k].size(); if (n < 1) continue;
                        double y = c.combBuf[k][c.combI[k]];
                        c.combF[k] = y * (1.0 - rvDamp) + c.combF[k] * rvDamp;
                        c.combBuf[k][c.combI[k]] = (float) (input + c.combF[k] * rvFb);
                        c.combI[k] = (c.combI[k] + 1) % n; out += y;
                    }
                    double s = out;
                    for (int k = 0; k < 4; ++k) {
                        int n = (int) c.apBuf[k].size(); if (n < 1) continue;
                        double bufout = c.apBuf[k][c.apI[k]];
                        double o = -s + bufout;
                        c.apBuf[k][c.apI[k]] = (float) (s + bufout * 0.5);
                        c.apI[k] = (c.apI[k] + 1) % n; s = o;
                    }
                    x = x * (1.0 - rvMix) + s * rvMix;
                }
                d[i] = (float) x;
            }
        }
    }
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
