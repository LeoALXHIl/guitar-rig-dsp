#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_dsp/juce_dsp.h>
#include <vector>
#include <cmath>

#ifndef M_PI
 #define M_PI 3.14159265358979323846
#endif

// =============================================================================
// Guitar Rig DSP — plugin JUCE (MVP da Fase 6).
// Porta o PREAMP do amp "800-style" (JCM800 2203) do guitar-rig-dsp web:
// 3 estágios de triodo (tanh + Miller LP + acoplamento HP) → tone stack
// (bass/mid/treble) → presence/depth → power amp (+ sag) → trafo de saída.
// Roda a 4× oversampling (juce::dsp::Oversampling) pra matar aliasing em alto ganho.
// A matemática é idêntica à verificada no harness Node do projeto web.
// =============================================================================

class GuitarRigDSPAudioProcessor : public juce::AudioProcessor
{
public:
    GuitarRigDSPAudioProcessor();
    ~GuitarRigDSPAudioProcessor() override = default;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override { return new juce::GenericAudioProcessorEditor (*this); }
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "Guitar Rig DSP"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    juce::AudioProcessorValueTreeState apvts;

private:
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout();

    // ── Biquad (RBJ), Transposed Direct Form II — igual ao amp-processor.js ──
    struct Biquad
    {
        double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
        void reset() { z1 = z2 = 0; }
        void norm (double B0, double B1, double B2, double A0, double A1, double A2)
        { b0 = B0/A0; b1 = B1/A0; b2 = B2/A0; a1 = A1/A0; a2 = A2/A0; }
        void peaking (double fs, double f0, double Q, double dB)
        {
            double A = std::pow (10.0, dB/40.0), w0 = 2*M_PI*f0/fs;
            double c = std::cos (w0), al = std::sin (w0)/(2*Q);
            norm (1+al*A, -2*c, 1-al*A, 1+al/A, -2*c, 1-al/A);
        }
        void highpass (double fs, double f0, double Q)
        {
            double w0 = 2*M_PI*f0/fs, c = std::cos (w0), al = std::sin (w0)/(2*Q);
            norm ((1+c)/2, -(1+c), (1+c)/2, 1+al, -2*c, 1-al);
        }
        void lowpass (double fs, double f0, double Q)
        {
            double w0 = 2*M_PI*f0/fs, c = std::cos (w0), al = std::sin (w0)/(2*Q);
            norm ((1-c)/2, 1-c, (1-c)/2, 1+al, -2*c, 1-al);
        }
        void lowShelf (double fs, double f0, double dB)
        {
            double A = std::pow (10.0, dB/40.0), w0 = 2*M_PI*f0/fs;
            double c = std::cos (w0), s = std::sin (w0), beta = std::sqrt (A)/0.9*s;
            norm (A*((A+1)-(A-1)*c+beta), 2*A*((A-1)-(A+1)*c), A*((A+1)-(A-1)*c-beta),
                  (A+1)+(A-1)*c+beta, -2*((A-1)+(A+1)*c), (A+1)+(A-1)*c-beta);
        }
        void highShelf (double fs, double f0, double dB)
        {
            double A = std::pow (10.0, dB/40.0), w0 = 2*M_PI*f0/fs;
            double c = std::cos (w0), s = std::sin (w0), beta = std::sqrt (A)/0.9*s;
            norm (A*((A+1)+(A-1)*c+beta), -2*A*((A-1)+(A+1)*c), A*((A+1)+(A-1)*c-beta),
                  (A+1)-(A-1)*c+beta, 2*((A-1)-(A+1)*c), (A+1)-(A-1)*c-beta);
        }
        inline double process (double x)
        {
            double y = b0*x + z1;
            z1 = b1*x - a1*y + z2;
            z2 = b2*x - a2*y;
            return y;
        }
    };

    struct OnePole { double x1 = 0, y1 = 0; void reset() { x1 = y1 = 0; } };
    static inline double hpCoef (double fc, double fs) { return std::exp (-2*M_PI*fc/fs); }
    static inline double lpCoef (double fc, double fs) { double dt = 1.0/fs, rc = 1.0/(2*M_PI*fc); return dt/(rc+dt); }
    static inline double highpass (double x, OnePole& st, double R) { double y = R*(st.y1 + x - st.x1); st.x1 = x; st.y1 = y; return y; }
    static inline double triode (double x, double g, double bias) { return -(std::tanh (g*x + bias) - std::tanh (bias)); }
    static inline double lerp (double a, double b, double t) { return a + (b-a)*t; }

    // estado por canal (à taxa 4×)
    struct Ch
    {
        double miller[4] = {0,0,0,0};
        OnePole dc, cpl0, cpl1, xfmrHP;
        Biquad bassF, midF, trebF, presF, depthF, xfmrRes;
        double sagEnv = 0;
        // pedais de sujeira (na região 4×, antes do amp)
        double odLp = 0;                 // tone do overdrive
        OnePole fzDc; double fzMid = 0, fzToneLp = 0;   // fuzz
        // cabinet (aplicado pós power amp, à taxa 4×) — porta do makeCabMicIR do web
        Biquad cHP, cRes, cBody, cPres, cLP, cShelf;
        Biquad cBreak[5]; int nBreak = 0;
        Biquad cMicPk[2]; int nMicPk = 0;
        double comb[2048] = {0}; int combW = 0;
        void reset() { miller[0]=miller[1]=miller[2]=miller[3]=0; dc.reset(); cpl0.reset(); cpl1.reset(); xfmrHP.reset();
                       bassF.reset(); midF.reset(); trebF.reset(); presF.reset(); depthF.reset(); xfmrRes.reset(); sagEnv=0;
                       odLp=0; fzDc.reset(); fzMid=0; fzToneLp=0;
                       cHP.reset(); cRes.reset(); cBody.reset(); cPres.reset(); cLP.reset(); cShelf.reset();
                       for (auto& b : cBreak) b.reset(); for (auto& b : cMicPk) b.reset();
                       for (auto& x : comb) x = 0; combW = 0; }
    };
    std::vector<Ch> chans;

    std::unique_ptr<juce::dsp::Oversampling<float>> oversampling;
    static constexpr int OS_LOG2 = 2;   // 2^2 = 4×
    double fs = 44100.0, fsOS = 176400.0;

    // suavização de parâmetros
    float sGain = 0.6f, sMaster = 0.5f, smA = 0.02f;

    // parâmetros (ponteiros atômicos)
    std::atomic<float>* pGain = nullptr;
    std::atomic<float>* pBass = nullptr;
    std::atomic<float>* pMid = nullptr;
    std::atomic<float>* pTreble = nullptr;
    std::atomic<float>* pPresence = nullptr;
    std::atomic<float>* pDepth = nullptr;
    std::atomic<float>* pMaster = nullptr;
    std::atomic<float>* pOutput = nullptr;
    std::atomic<float>* pModel = nullptr;    // 0=800 1=5150 2=Twin 3=Recto
    std::atomic<float>* pChannel = nullptr;  // 0..2 (depende do amp)
    std::atomic<float>* pBright = nullptr;
    std::atomic<float>* pCabOn = nullptr;
    std::atomic<float>* pCab = nullptr;       // 0=4x12 1=2x12 2=1x12
    std::atomic<float>* pSpeaker = nullptr;   // 0=v30 1=green 2=cream
    std::atomic<float>* pMic = nullptr;       // 0=sm57 1=md421 2=r121
    std::atomic<float>* pAxis = nullptr;
    std::atomic<float>* pDistance = nullptr;
    std::atomic<float>* pOdOn = nullptr;  std::atomic<float>* pOdDrive = nullptr; std::atomic<float>* pOdTone = nullptr; std::atomic<float>* pOdLevel = nullptr;
    std::atomic<float>* pFzOn = nullptr;  std::atomic<float>* pFzSustain = nullptr; std::atomic<float>* pFzTone = nullptr; std::atomic<float>* pFzLevel = nullptr;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GuitarRigDSPAudioProcessor)
};
