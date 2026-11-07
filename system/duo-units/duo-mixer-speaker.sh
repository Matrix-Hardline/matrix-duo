#!/bin/bash
# Wiedergabepfad Lautsprecher (deep-buffer-playback + speaker) aus mixer_paths_tavil.xml
C=${1:-0}
# --- Pfad deep-buffer-playback
amixer -q -c ${C:-0} cset name='SLIMBUS_0_RX Audio Mixer MultiMedia1' 1
# --- Pfad speaker
amixer -q -c ${C:-0} cset name='SLIM RX0 MUX' 'AIF1_PB'
amixer -q -c ${C:-0} cset name='CDC_IF RX0 MUX' 'SLIM RX0'
amixer -q -c ${C:-0} cset name='SLIM_0_RX Channels' 'One'
amixer -q -c ${C:-0} cset name='RX INT7_1 MIX1 INP0' 'RX0'
amixer -q -c ${C:-0} cset name='COMP7 Switch' 1
amixer -q -c ${C:-0} cset name='SpkrLeft COMP Switch' 1
amixer -q -c ${C:-0} cset name='SpkrLeft BOOST Switch' 1
amixer -q -c ${C:-0} cset name='SpkrLeft VISENSE Switch' 1
amixer -q -c ${C:-0} cset name='SpkrLeft SWR DAC_Port Switch' 1
