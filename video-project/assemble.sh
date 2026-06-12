#!/usr/bin/env bash
# Assembles the final documentary from generated assets.
# Requires: ffmpeg, jq, curl, and network access to the Higgsfield CDN.
# Layout per scene: narration WAV sets the scene duration; visuals
# (5s motion clips + Ken Burns stills) are tiled/looped to fill it,
# joined with crossfades, then all scenes are concatenated and the
# music bed is ducked under the voiceover.
set -euo pipefail
cd "$(dirname "$0")"

W=1920; H=1080; FPS=30
mkdir -p audio clips images segments output

# ---------- 1. Download everything in the manifest ----------
echo "== downloading audio =="
jq -r '.audio[] | select(.url != "PENDING") | "\(.name) \(.url)"' manifest.json | \
while read -r name url; do
  [ -s "audio/$name.wav" ] || curl -fsS -o "audio/$name.wav" "$url"
done

echo "== downloading clips =="
jq -r '(.clips_resolved // [])[] | "\(.name) \(.url)"' manifest.json | \
while read -r name url; do
  [ -s "clips/$name.mp4" ] || curl -fsS -o "clips/$name.mp4" "$url"
done

echo "== downloading images =="
jq -r '(.images_resolved // [])[] | "\(.name) \(.url)"' manifest.json | \
while read -r name url; do
  [ -s "images/$name.png" ] || curl -fsS -o "images/$name.png" "$url"
done

# ---------- 2. Helpers ----------
dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }

# Ken Burns: turn a still into DUR seconds of slow zoom video
kenburns() { # $1=img $2=outfile $3=duration $4=direction(in|out)
  local img=$1 out=$2 d=$3 dir=${4:-in}
  local frames; frames=$(printf '%.0f' "$(echo "$d * $FPS" | bc)")
  local z
  if [ "$dir" = "in" ];  then z="zoom+0.0006"; else z="if(eq(on,1),1.18,zoom-0.0006)"; fi
  ffmpeg -y -v error -loop 1 -i "$img" -t "$d" -filter_complex \
    "[0:v]scale=8000:-1,zoompan=z='$z':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=$frames:s=${W}x${H}:fps=$FPS,format=yuv420p" \
    -an "$out"
}

# Fit a motion clip to canvas
fit() { # $1=in $2=out
  ffmpeg -y -v error -i "$1" -vf "scale=$W:$H:force_original_aspect_ratio=increase,crop=$W:$H,fps=$FPS,format=yuv420p" -an "$2"
}

# ---------- 3. Build each scene from scene_layout in manifest ----------
# scene_layout: [{scene, audio, visuals:[{type:clip|image, name, hold}]}]
echo "== building scenes =="
n_scenes=$(jq '.scene_layout | length' manifest.json)
for i in $(seq 0 $((n_scenes-1))); do
  scene=$(jq -r ".scene_layout[$i].scene" manifest.json)
  aname=$(jq -r ".scene_layout[$i].audio" manifest.json)
  adur=$(dur "audio/$aname.wav")
  echo "scene $scene: narration ${adur}s"

  # Build visual sub-segments until we cover adur (+0.5s tail)
  target=$(echo "$adur + 0.5" | bc)
  covered=0; idx=0; parts=()
  nvis=$(jq ".scene_layout[$i].visuals | length" manifest.json)
  while (( $(echo "$covered < $target" | bc) )); do
    v=$(( idx % nvis ))
    vtype=$(jq -r ".scene_layout[$i].visuals[$v].type" manifest.json)
    vname=$(jq -r ".scene_layout[$i].visuals[$v].name" manifest.json)
    hold=$(jq -r ".scene_layout[$i].visuals[$v].hold // 6" manifest.json)
    seg="segments/s${scene}_p${idx}.mp4"
    if [ "$vtype" = "clip" ]; then
      fit "clips/$vname.mp4" "$seg"
      hold=$(dur "$seg")
    else
      kb=$([ $((idx % 2)) -eq 0 ] && echo in || echo out)
      kenburns "images/$vname.png" "$seg" "$hold" "$kb"
    fi
    parts+=("$seg"); covered=$(echo "$covered + $hold" | bc); idx=$((idx+1))
  done

  # Concat parts with 0.5s crossfades
  cur="${parts[0]}"
  for ((p=1; p<${#parts[@]}; p++)); do
    nxt="${parts[$p]}"; outx="segments/s${scene}_x${p}.mp4"
    cd_=$(dur "$cur"); off=$(echo "$cd_ - 0.5" | bc)
    ffmpeg -y -v error -i "$cur" -i "$nxt" -filter_complex \
      "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=$off,format=yuv420p" -an "$outx"
    cur="$outx"
  done

  # Trim to narration length + attach narration
  ffmpeg -y -v error -i "$cur" -i "audio/$aname.wav" -t "$target" \
    -map 0:v -map 1:a -c:v libx264 -preset medium -crf 19 -c:a aac -b:a 192k \
    -af "apad" -shortest "segments/scene${scene}.mp4"
done

# ---------- 4. Concatenate all scenes ----------
echo "== concatenating =="
: > segments/list.txt
for i in $(seq 0 $((n_scenes-1))); do
  scene=$(jq -r ".scene_layout[$i].scene" manifest.json)
  echo "file 'scene${scene}.mp4'" >> segments/list.txt
done
ffmpeg -y -v error -f concat -safe 0 -i segments/list.txt -c copy output/narration_cut.mp4

# ---------- 5. Music bed (optional), ducked under VO ----------
if [ -s audio/music_bed.wav ] || [ -s audio/music_bed.mp3 ]; then
  MB=$(ls audio/music_bed.* | head -1)
  ffmpeg -y -v error -i output/narration_cut.mp4 -stream_loop -1 -i "$MB" -filter_complex \
    "[1:a]volume=0.16,apad[m];[0:a][m]sidechaincompress=threshold=0.03:ratio=8:attack=5:release=400[mix];[0:a][mix]amix=inputs=2:duration=first:weights=1 0.9[a]" \
    -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 256k output/final.mp4
else
  cp output/narration_cut.mp4 output/final.mp4
fi

echo "== DONE: output/final.mp4 =="
ffprobe -v error -show_entries format=duration -of csv=p=0 output/final.mp4
