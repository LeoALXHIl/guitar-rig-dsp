#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include "PluginProcessor.h"
#include <vector>

// LookAndFeel próprio: knobs com anel de glow no accent + tema escuro.
class GrdLookAndFeel : public juce::LookAndFeel_V4
{
public:
    GrdLookAndFeel();
    void drawRotarySlider (juce::Graphics&, int x, int y, int w, int h,
                           float pos, float startAngle, float endAngle, juce::Slider&) override;
    void drawToggleButton (juce::Graphics&, juce::ToggleButton&, bool, bool) override;
    void drawComboBox (juce::Graphics&, int w, int h, bool, int, int, int, int, juce::ComboBox&) override;
    juce::Font getComboBoxFont (juce::ComboBox&) override;
    juce::Colour accent { 0xffe0a24a };
};

// Uma "página" data-driven: recebe uma lista de controles e monta/liga tudo sozinha.
struct GrdPage : public juce::Component
{
    struct Ctl { enum T { Knob, Toggle, Combo } type; const char* id; const char* name; };
    GrdPage (juce::AudioProcessorValueTreeState& s, std::vector<Ctl> ctls, bool amp = false);
    void resized() override;
    void paint (juce::Graphics&) override;

    bool isAmp = false; int topPad = 14;
    juce::AudioProcessorValueTreeState& state;
    std::vector<Ctl> controls;
    juce::OwnedArray<juce::Slider> sliders;
    juce::OwnedArray<juce::ToggleButton> toggles;
    juce::OwnedArray<juce::ComboBox> combos;
    juce::OwnedArray<juce::Label> labels;
    juce::OwnedArray<juce::AudioProcessorValueTreeState::SliderAttachment> sAtt;
    juce::OwnedArray<juce::AudioProcessorValueTreeState::ButtonAttachment> bAtt;
    juce::OwnedArray<juce::AudioProcessorValueTreeState::ComboBoxAttachment> cAtt;
    std::vector<juce::Component*> cells;  // na ordem, pra layout
};

class GuitarRigDSPAudioProcessorEditor : public juce::AudioProcessorEditor,
                                         private juce::Timer
{
public:
    explicit GuitarRigDSPAudioProcessorEditor (GuitarRigDSPAudioProcessor&);
    ~GuitarRigDSPAudioProcessorEditor() override;
    void paint (juce::Graphics&) override;
    void resized() override;
    void timerCallback() override;

private:
    GuitarRigDSPAudioProcessor& proc;
    GrdLookAndFeel lnf;
    juce::TabbedComponent tabs { juce::TabbedButtonBar::TabsAtTop };
    juce::OwnedArray<GrdPage> pages;
    float meterDisp = 0.0f, meterPeak = 0.0f; int peakHold = 0, lastModel = -1;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GuitarRigDSPAudioProcessorEditor)
};
