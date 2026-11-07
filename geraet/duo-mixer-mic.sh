#!/bin/bash
# Capture path for the built-in microphone (05.11.2026), from mixer_paths_tavil.xml «audio-record» + «dmic3»:
# DMIC2 -> DEC7 -> CDC_IF TX7 -> AIF1_CAP/SLIM TX7 -> SLIM_0_TX -> MultiMedia1 capture (hw:0,0 capture).
# Measured with a 1 kHz tone from the speaker: DMIC2 and DMIC3 hear it (DMIC2 most clearly), DMIC0/1 barely,
# DMIC4/5 unused. DEC7 Volume 96 (= +12 dB compared to Android's 84): best signal-to-noise ratio.
C=${1:-0}
amixer -q -c $C cset name='MultiMedia1 Mixer SLIM_0_TX' 1
amixer -q -c $C cset name='AIF1_CAP Mixer SLIM TX7' 1
amixer -q -c $C cset name='CDC_IF TX7 MUX' 'DEC7'
amixer -q -c $C cset name='SLIM_0_TX Channels' 'One'
amixer -q -c $C cset name='ADC MUX7' 'DMIC'
amixer -q -c $C cset name='DMIC MUX7' 'DMIC2'
amixer -q -c $C cset name='DEC7 Volume' 96
