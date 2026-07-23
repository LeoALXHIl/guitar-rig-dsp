cmake_minimum_required(VERSION 3.22)
project(GuitarRigDSP VERSION 0.1.0 LANGUAGES CXX)

# ── JUCE via FetchContent (baixa o framework automaticamente) ──
include(FetchContent)
FetchContent_Declare(
  JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG        8.0.4          # pode subir p/ 9.0.x; a API de CMake é a mesma
  GIT_SHALLOW    TRUE)
FetchContent_MakeAvailable(JUCE)

juce_add_plugin(GuitarRigDSP
  COMPANY_NAME              "NexTags"
  PLUGIN_MANUFACTURER_CODE  Ntgs
  PLUGIN_CODE               Grd1
  FORMATS                   VST3 Standalone
  PRODUCT_NAME              "Guitar Rig DSP"
  IS_SYNTH                  FALSE
  NEEDS_MIDI_INPUT          FALSE
  NEEDS_MIDI_OUTPUT         FALSE
  IS_MIDI_EFFECT            FALSE
  COPY_PLUGIN_AFTER_BUILD   FALSE)         # NÃO copia pro Program Files (evita erro de admin); instala-se manualmente

target_sources(GuitarRigDSP PRIVATE
  Source/PluginProcessor.cpp)

target_compile_features(GuitarRigDSP PRIVATE cxx_std_17)

target_compile_definitions(GuitarRigDSP PRIVATE
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_VST3_CAN_REPLACE_VST2=0)

target_link_libraries(GuitarRigDSP PRIVATE
  juce::juce_audio_utils
  juce::juce_dsp
  juce::juce_recommended_config_flags
  juce::juce_recommended_lto_flags
  juce::juce_recommended_warning_flags)
