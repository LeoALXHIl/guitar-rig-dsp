#include "PluginEditor.h"

#ifndef M_PI
 #define M_PI 3.14159265358979323846
#endif

// ============================== LookAndFeel ==============================
GrdLookAndFeel::GrdLookAndFeel()
{
    setColour (juce::ResizableWindow::backgroundColourId, juce::Colour (0xff141416));
    setColour (juce::Slider::textBoxTextColourId,        accent);
    setColour (juce::Slider::textBoxOutlineColourId,     juce::Colours::transparentBlack);
    setColour (juce::Label::textColourId,                juce::Colour (0xffbdbbb2));
    setColour (juce::ComboBox::backgroundColourId,       juce::Colour (0xff17181b));
    setColour (juce::ComboBox::textColourId,             juce::Colour (0xffeceae4));
    setColour (juce::ComboBox::outlineColourId,          juce::Colour (0xff33343a));
    setColour (juce::TextButton::buttonColourId,         juce::Colour (0xff17181b));
    setColour (juce::TabbedComponent::backgroundColourId, juce::Colour (0xff0e0e10));
    setColour (juce::TabbedButtonBar::tabTextColourId,    juce::Colour (0xff8b8a83));
    setColour (juce::TabbedButtonBar::frontTextColourId, accent);
}

void GrdLookAndFeel::drawRotarySlider (juce::Graphics& g, int x, int y, int w, int h,
                                       float pos, float a0, float a1, juce::Slider&)
{
    auto b = juce::Rectangle<float> ((float) x, (float) y, (float) w, (float) h).reduced (6.0f);
    auto cx = b.getCentreX(), cy = b.getCentreY();
    auto r = juce::jmin (b.getWidth(), b.getHeight()) * 0.5f;
    auto ang = a0 + pos * (a1 - a0);

    // trilha
    juce::Path track; track.addCentredArc (cx, cy, r, r, 0.0f, a0, a1, true);
    g.setColour (juce::Colour (0xff2a2b30)); g.strokePath (track, juce::PathStrokeType (3.0f));
    // arco de valor (accent) + glow
    juce::Path val; val.addCentredArc (cx, cy, r, r, 0.0f, a0, ang, true);
    g.setColour (accent.withAlpha (0.30f)); g.strokePath (val, juce::PathStrokeType (6.0f));
    g.setColour (accent);                    g.strokePath (val, juce::PathStrokeType (3.0f));
    // corpo do knob
    auto kr = r * 0.66f;
    juce::ColourGradient grad (juce::Colour (0xff3a3d44), cx, cy - kr, juce::Colour (0xff1b1c20), cx, cy + kr, false);
    g.setGradientFill (grad); g.fillEllipse (cx - kr, cy - kr, kr * 2, kr * 2);
    g.setColour (juce::Colour (0xff0c0c0e)); g.drawEllipse (cx - kr, cy - kr, kr * 2, kr * 2, 1.5f);
    // ponteiro
    juce::Point<float> tip (cx + std::cos (ang - juce::MathConstants<float>::halfPi) * kr * 0.9f,
                            cy + std::sin (ang - juce::MathConstants<float>::halfPi) * kr * 0.9f);
    g.setColour (accent);
    g.drawLine (cx, cy, tip.x, tip.y, 2.5f);
}

void GrdLookAndFeel::drawToggleButton (juce::Graphics& g, juce::ToggleButton& b, bool, bool)
{
    auto r = b.getLocalBounds().toFloat().reduced (2.0f);
    bool on = b.getToggleState();
    float rad = r.getHeight() * 0.5f;
    g.setColour (on ? accent : juce::Colour (0xff2a2b30));
    g.fillRoundedRectangle (r, rad);
    if (on) { g.setColour (accent.withAlpha (0.35f)); g.drawRoundedRectangle (r.expanded (1.5f), rad + 1.5f, 3.0f); }
    float d = r.getHeight() - 6.0f;
    float kx = on ? r.getRight() - d - 3.0f : r.getX() + 3.0f;
    g.setColour (juce::Colour (0xfff4f2ec));
    g.fillEllipse (kx, r.getY() + 3.0f, d, d);
}

void GrdLookAndFeel::drawComboBox (juce::Graphics& g, int w, int h, bool, int, int, int, int, juce::ComboBox&)
{
    auto r = juce::Rectangle<float> (0, 0, (float) w, (float) h).reduced (1.0f);
    g.setColour (juce::Colour (0xff101114)); g.fillRoundedRectangle (r, 6.0f);
    g.setColour (juce::Colour (0xff33343a)); g.drawRoundedRectangle (r, 6.0f, 1.0f);
    juce::Path p; float cx = w - 14.0f, cy = h * 0.5f;
    p.addTriangle (cx - 4, cy - 2, cx + 4, cy - 2, cx, cy + 3);
    g.setColour (accent); g.fillPath (p);
}

juce::Font GrdLookAndFeel::getComboBoxFont (juce::ComboBox&) { return juce::Font (13.0f, juce::Font::bold); }

void GrdLookAndFeel::drawButtonBackground (juce::Graphics& g, juce::Button& b, const juce::Colour&, bool hl, bool)
{
    auto r = b.getLocalBounds().toFloat().reduced (1.0f);
    bool on = b.getToggleState();
    g.setColour (on ? accent.withAlpha (0.16f) : juce::Colour (0xff17181b));
    g.fillRoundedRectangle (r, 8.0f);
    g.setColour (on ? accent : (hl ? juce::Colour (0xff45464d) : juce::Colour (0xff26272d)));
    g.drawRoundedRectangle (r, 8.0f, on ? 1.5f : 1.0f);
    if (on) { g.setColour (accent); g.fillRoundedRectangle (r.getX() + 3.0f, r.getY() + 5.0f, 3.0f, r.getHeight() - 10.0f, 1.5f); }
}

// ============================== Page ==============================
GrdPage::GrdPage (juce::AudioProcessorValueTreeState& s, std::vector<Ctl> ctls, bool amp)
    : isAmp (amp), topPad (amp ? 50 : 14), state (s), controls (std::move (ctls))
{
    for (auto& c : controls)
    {
        auto* lbl = labels.add (new juce::Label ({}, c.name));
        lbl->setJustificationType (juce::Justification::centred);
        lbl->setFont (juce::Font (10.5f, juce::Font::bold));
        lbl->setColour (juce::Label::textColourId, juce::Colour (0xff9a988f));
        addAndMakeVisible (lbl);

        if (c.type == Ctl::Knob)
        {
            auto* sl = sliders.add (new juce::Slider (juce::Slider::RotaryHorizontalVerticalDrag, juce::Slider::TextBoxBelow));
            sl->setTextBoxStyle (juce::Slider::TextBoxBelow, false, 70, 15);
            addAndMakeVisible (sl);
            sAtt.add (new juce::AudioProcessorValueTreeState::SliderAttachment (state, c.id, *sl));
            cells.push_back (sl);
        }
        else if (c.type == Ctl::Toggle)
        {
            auto* tg = toggles.add (new juce::ToggleButton());
            addAndMakeVisible (tg);
            bAtt.add (new juce::AudioProcessorValueTreeState::ButtonAttachment (state, c.id, *tg));
            cells.push_back (tg);
        }
        else // Combo
        {
            auto* cb = combos.add (new juce::ComboBox());
            if (auto* choice = dynamic_cast<juce::AudioParameterChoice*> (state.getParameter (c.id)))
                cb->addItemList (choice->choices, 1);
            addAndMakeVisible (cb);
            cAtt.add (new juce::AudioProcessorValueTreeState::ComboBoxAttachment (state, c.id, *cb));
            cells.push_back (cb);
        }
    }
}

void GrdPage::paint (juce::Graphics& g)
{
    auto panel = getLocalBounds().toFloat().reduced (6.0f);
    g.setColour (juce::Colour (0xff141518)); g.fillRoundedRectangle (panel, 12.0f);
    g.setColour (juce::Colour (0xff2a2b30)); g.drawRoundedRectangle (panel, 12.0f, 1.0f);
    if (! isAmp) return;
    int m = 0;
    if (auto* ch = dynamic_cast<juce::AudioParameterChoice*> (state.getParameter ("model"))) m = ch->getIndex();
    static const char* names[4] = { "800-style · 2203", "5150-style · Lead", "Clean US · Twin", "Rectifier · Modern" };
    const juce::Colour top[4] = { juce::Colour (0xffeccb70), juce::Colour (0xff33363c), juce::Colour (0xff5ab4e0), juce::Colour (0xffd4564a) };
    const juce::Colour bot[4] = { juce::Colour (0xffa67f28), juce::Colour (0xff131417), juce::Colour (0xff1d5c7e), juce::Colour (0xff7a1c15) };
    const bool dark = (m == 0 || m == 2);   // texto escuro sobre placa clara
    auto band = juce::Rectangle<float> (10.0f, 8.0f, (float) getWidth() - 20.0f, 34.0f);
    g.setGradientFill (juce::ColourGradient (top[m], 0, band.getY(), bot[m], 0, band.getBottom(), false));
    g.fillRoundedRectangle (band, 6.0f);
    g.setColour (juce::Colours::white.withAlpha (0.65f)); g.drawRoundedRectangle (band, 6.0f, 1.5f);
    g.setColour (dark ? juce::Colour (0xff241704) : juce::Colours::white);
    g.setFont (juce::Font (15.0f, juce::Font::bold));
    g.drawText (names[m], band.reduced (14.0f, 0.0f), juce::Justification::centredLeft);
}

void GrdPage::resized()
{
    const int cellW = 128, cellH = 122, pad = 20;
    int cols = juce::jmax (1, (getWidth() - pad) / cellW);
    for (size_t i = 0; i < cells.size(); ++i)
    {
        int col = (int) i % cols, row = (int) i / cols;
        int x = pad + col * cellW, y = topPad + 6 + row * cellH;
        int cw = cellW - 12;
        labels[(int) i]->setBounds (x, y, cw, 15);
        auto* comp = cells[i];
        if (auto* sl = dynamic_cast<juce::Slider*> (comp)) sl->setBounds (x, y + 15, cw, cellH - 26);
        else if (auto* tg = dynamic_cast<juce::ToggleButton*> (comp)) tg->setBounds (x + cw / 2 - 26, y + 40, 52, 26);
        else comp->setBounds (x, y + 44, cw, 28);   // combo
    }
}

// ============================== Editor ==============================
GuitarRigDSPAudioProcessorEditor::GuitarRigDSPAudioProcessorEditor (GuitarRigDSPAudioProcessor& p)
    : juce::AudioProcessorEditor (&p), proc (p)
{
    setLookAndFeel (&lnf);

    using Ctl = GrdPage::Ctl;
    struct Mod { const char* name; std::vector<Ctl> ctls; bool amp; };
    std::vector<Mod> mods = {
        { "GATE",   {{Ctl::Toggle,"gateOn","On"},{Ctl::Knob,"gateThr","Thresh"},{Ctl::Knob,"gateRel","Release"}}, false },
        { "COMP",   {{Ctl::Toggle,"compOn","On"},{Ctl::Knob,"compThr","Thresh"},{Ctl::Knob,"compRatio","Ratio"},{Ctl::Knob,"compMakeup","Makeup"}}, false },
        { "FUZZ",   {{Ctl::Toggle,"fzOn","On"},{Ctl::Knob,"fzSustain","Sustain"},{Ctl::Knob,"fzTone","Tone"},{Ctl::Knob,"fzLevel","Level"}}, false },
        { "DRIVE",  {{Ctl::Toggle,"odOn","On"},{Ctl::Knob,"odDrive","Drive"},{Ctl::Knob,"odTone","Tone"},{Ctl::Knob,"odLevel","Level"}}, false },
        { "AMP",    {{Ctl::Combo,"model","Amp"},{Ctl::Knob,"channel","Canal"},{Ctl::Toggle,"bright","Bright"},{Ctl::Knob,"gain","Gain"},{Ctl::Knob,"bass","Bass"},{Ctl::Knob,"mid","Mid"},{Ctl::Knob,"treble","Treble"},{Ctl::Knob,"presence","Presence"},{Ctl::Knob,"depth","Depth"},{Ctl::Knob,"master","Master"},{Ctl::Knob,"output","Output"}}, true },
        { "EQ",     {{Ctl::Toggle,"eqOn","On"},{Ctl::Knob,"eqLow","Low"},{Ctl::Knob,"eqMid","Mid"},{Ctl::Knob,"eqHigh","High"},{Ctl::Knob,"eqMidFreq","Freq"},{Ctl::Knob,"eqMidQ","Q"},{Ctl::Knob,"eqHP","HP"},{Ctl::Knob,"eqLP","LP"}}, false },
        { "CAB",    {{Ctl::Toggle,"cabOn","On"},{Ctl::Combo,"cab","Caixa"},{Ctl::Combo,"speaker","Falante"},{Ctl::Combo,"mic","Mic"},{Ctl::Knob,"axis","Axis"},{Ctl::Knob,"distance","Dist"}}, false },
        { "CHORUS", {{Ctl::Toggle,"choOn","On"},{Ctl::Knob,"choRate","Rate"},{Ctl::Knob,"choDepth","Depth"},{Ctl::Knob,"choMix","Mix"}}, false },
        { "PHASER", {{Ctl::Toggle,"phOn","On"},{Ctl::Knob,"phRate","Rate"},{Ctl::Knob,"phDepth","Depth"},{Ctl::Knob,"phFb","FB"},{Ctl::Knob,"phMix","Mix"}}, false },
        { "DELAY",  {{Ctl::Toggle,"dlyOn","On"},{Ctl::Knob,"dlyTime","Time"},{Ctl::Knob,"dlyFb","FB"},{Ctl::Knob,"dlyTone","Tone"},{Ctl::Knob,"dlyMix","Mix"}}, false },
        { "REVERB", {{Ctl::Toggle,"rvOn","On"},{Ctl::Knob,"rvSize","Size"},{Ctl::Knob,"rvDamp","Damp"},{Ctl::Knob,"rvMix","Mix"}}, false },
    };
    for (int i = 0; i < (int) mods.size(); ++i)
    {
        auto* pg = pages.add (new GrdPage (proc.apvts, mods[i].ctls, mods[i].amp));
        addChildComponent (pg);
        auto* ch = chips.add (new juce::TextButton (mods[i].name));
        ch->setClickingTogglesState (true); ch->setRadioGroupId (100);
        ch->setColour (juce::TextButton::textColourOnId,  lnf.accent);
        ch->setColour (juce::TextButton::textColourOffId, juce::Colour (0xff8b8a83));
        ch->onClick = [this, i] { showPage (i); };
        addAndMakeVisible (ch);
    }

    setResizable (true, true);
    setResizeLimits (640, 380, 1400, 900);
    setSize (860, 560);
    showPage (4);   // abre no AMP (como a web)
    startTimerHz (30);
}

void GuitarRigDSPAudioProcessorEditor::showPage (int idx)
{
    current = idx;
    for (int i = 0; i < pages.size(); ++i) pages[i]->setVisible (i == idx);
    if (idx < chips.size()) chips[idx]->setToggleState (true, juce::dontSendNotification);
}

void GuitarRigDSPAudioProcessorEditor::timerCallback()
{
    float lv = proc.outLevel.load();
    meterDisp = lv > meterDisp ? lv : meterDisp * 0.85f;         // ataque rápido, release lento
    if (lv >= meterPeak) { meterPeak = lv; peakHold = 30; }
    else if (--peakHold <= 0) meterPeak *= 0.93f;
    repaint (getWidth() - 230, 0, 230, 38);

    if (auto* ch = dynamic_cast<juce::AudioParameterChoice*> (proc.apvts.getParameter ("model")))
        if (ch->getIndex() != lastModel) { lastModel = ch->getIndex(); if (pages.size() > 4) pages[4]->repaint(); }
}

GuitarRigDSPAudioProcessorEditor::~GuitarRigDSPAudioProcessorEditor()
{
    setLookAndFeel (nullptr);
}

void GuitarRigDSPAudioProcessorEditor::paint (juce::Graphics& g)
{
    juce::ColourGradient bg (juce::Colour (0xff1a1a1e), 0, 0, juce::Colour (0xff0b0b0d), 0, (float) getHeight(), false);
    g.setGradientFill (bg); g.fillAll();
    // faixa de título
    g.setColour (lnf.accent);
    g.setFont (juce::Font (17.0f, juce::Font::bold));
    g.drawText ("GUITAR RIG DSP", 16, 8, getWidth() - 260, 26, juce::Justification::left);

    // VU meter de saída
    auto mb = juce::Rectangle<float> ((float) getWidth() - 178.0f, 14.0f, 150.0f, 11.0f);
    g.setColour (juce::Colour (0xff09090a)); g.fillRoundedRectangle (mb, 3.0f);
    float db = juce::Decibels::gainToDecibels (meterDisp, -60.0f);
    float frac = juce::jlimit (0.0f, 1.0f, (db + 60.0f) / 60.0f);
    juce::Colour mc = meterDisp > 0.98f ? juce::Colour (0xffe64a5a)
                    : meterDisp > 0.70f ? juce::Colour (0xffe0a24a) : juce::Colour (0xff5fd47a);
    g.setColour (mc); g.fillRoundedRectangle (mb.withWidth (mb.getWidth() * frac), 3.0f);
    float pf = juce::jlimit (0.0f, 1.0f, (juce::Decibels::gainToDecibels (meterPeak, -60.0f) + 60.0f) / 60.0f);
    g.setColour (juce::Colours::white.withAlpha (0.8f));
    g.fillRect (mb.getX() + mb.getWidth() * pf, mb.getY(), 2.0f, mb.getHeight());
    g.setColour (juce::Colour (0xff6b6a63)); g.setFont (juce::Font (9.0f));
    g.drawText ("OUT", (int) getWidth() - 26, 13, 24, 13, juce::Justification::left);
}

void GuitarRigDSPAudioProcessorEditor::resized()
{
    auto r = getLocalBounds();
    r.removeFromTop (40);
    auto rail = r.removeFromLeft (140);
    int y = rail.getY() + 6;
    for (auto* ch : chips) { ch->setBounds (rail.getX() + 10, y, rail.getWidth() - 18, 34); y += 40; }
    auto content = r.reduced (6);
    for (auto* pg : pages) pg->setBounds (content);
}
