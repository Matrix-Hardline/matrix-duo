#!/bin/sh
# duo-speicher (04.11.2026): memory/bus governors as Android's init.qcom.post_boot.sh (msmnile) sets them.
# Fedora never ran that script: every devfreq node stayed on "performance" — and the NPU's DDR vote
# (npu-npu-ddr-bw, NOT active-only) kept DDR at full bandwidth even in suspend: the chip never reached CXSD.
# NPU: powersave (Android uses bw_hwmon, which needs the NPU powered — we never start the NPU).
C=/sys/class/devfreq
w() { [ -e "$2" ] && echo "$1" > "$2" 2>/dev/null; }
w powersave $C/soc:qcom,npu-npu-ddr-bw/governor
for m in $C/soc:qcom,cpu*-lat; do
  w mem_latency $m/governor; w 10 $m/polling_interval; w 400 $m/mem_latency/ratio_ceil
done
w 4000 $C/soc:qcom,cpu4-cpu-l3-lat/mem_latency/ratio_ceil
w 20000 $C/soc:qcom,cpu7-cpu-l3-lat/mem_latency/ratio_ceil
w compute $C/soc:qcom,cpu4-cpu-ddr-latfloor/governor
w 10 $C/soc:qcom,cpu4-cpu-ddr-latfloor/polling_interval
hw() { b=$1; w bw_hwmon $b/governor; w "$2" $b/bw_hwmon/mbps_zones; w 4 $b/bw_hwmon/sample_ms; w $3 $b/bw_hwmon/io_percent
  w 20 $b/bw_hwmon/hist_memory; w 10 $b/bw_hwmon/hyst_length; w 30 $b/bw_hwmon/down_thres; w 0 $b/bw_hwmon/guard_band_mbps
  w 250 $b/bw_hwmon/up_scale; w 1600 $b/bw_hwmon/idle_mbps; w 40 $b/polling_interval; }
hw $C/soc:qcom,cpu-cpu-llcc-bw "2288 4577 7110 9155 12298 14236 15258" 50
hw $C/soc:qcom,cpu-llcc-ddr-bw "1720 2086 2929 3879 5161 5931 6881 7980" 80
# Round 93: Android's touch boost (msm cpu_boost, msmnile post_boot) — on every touch a higher minimum clock for 120 ms,
# otherwise the processor clocked up only slowly at the start of every swipe (first scroll frames 60-80 ms).
w "0:1324800 4:1804800 7:1804800" /sys/module/cpu_boost/parameters/input_boost_freq
w 120 /sys/module/cpu_boost/parameters/input_boost_ms
echo "duo-speicher: npu $(cat $C/soc:qcom,npu-npu-ddr-bw/governor), ddr $(cat $C/soc:qcom,cpu-llcc-ddr-bw/governor)"
