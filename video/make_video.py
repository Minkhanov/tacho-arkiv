"""
Build the Tacho demo video (<= 3 min): English AI voice-over, real screen recordings, burned-in captions.

    python video/make_video.py tts                 # narration -> video/work/audio/*.mp3, durations
    python video/make_video.py capture             # runs `npm run demo -- --pause-before-revoke N`, records the
                                                   # live inspector during the pause (needs `npx vite preview` on :4173)
    python video/make_video.py stage               # records the title / problem / terminal / why / crops scenes
    python video/make_video.py assemble            # cuts, concatenates, muxes, burns captions -> video/work/tacho-demo.mp4
    python video/make_video.py all

Requirements: Python 3.10+, `pip install edge-tts playwright imageio-ffmpeg`, `python -m playwright install chromium`.
Everything shown is real: the terminal scene replays the captured output of the demo run with its own
relative timing (compressed), and the inspector scenes are recordings of the live app reading Tiramisu.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIDEO = ROOT / "video"
WORK = VIDEO / "work"
AUDIO = WORK / "audio"
CLIPS = WORK / "clips"
NARR = json.loads((VIDEO / "narration.json").read_text(encoding="utf-8"))
APP = os.environ.get("TACHO_APP_URL", "http://localhost:4173/")
W, H, FPS = 1920, 1080, 30


def ffmpeg() -> str:
    if os.environ.get("FFMPEG"):
        return os.environ["FFMPEG"]
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg  # type: ignore

    return imageio_ffmpeg.get_ffmpeg_exe()


def run(cmd: list[str], cwd: Path | None = None) -> None:
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd[:6])} …\n{r.stderr[-2000:]}")


def wav_seconds(path: Path) -> float:
    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate()


# --------------------------------------------------------------------------------------------- tts
async def _tts() -> None:
    import edge_tts  # type: ignore

    AUDIO.mkdir(parents=True, exist_ok=True)
    durations = {}
    for seg in NARR["segments"]:
        mp3 = AUDIO / f"{seg['id']}.mp3"
        await edge_tts.Communicate(seg["text"], NARR["voice"], rate=NARR.get("rate", "+0%")).save(str(mp3))
        wav = AUDIO / f"{seg['id']}.wav"
        run([ffmpeg(), "-y", "-i", str(mp3), "-ar", "48000", "-ac", "2", str(wav)])
        durations[seg["id"]] = round(wav_seconds(wav), 3)
        print(f"  {seg['id']:<10} {durations[seg['id']]:6.2f} s")
    total = sum(durations.values()) + NARR["gapMs"] / 1000 * len(durations)
    (WORK / "durations.json").write_text(json.dumps(durations, indent=2))
    print(f"  total with gaps: {total:.1f} s (limit 180)")
    if total > 178:
        sys.exit("narration too long: shorten the text or raise the rate")


def tts() -> None:
    asyncio.run(_tts())


def seg_seconds(seg_id: str) -> float:
    d = json.loads((WORK / "durations.json").read_text())
    return d[seg_id] + NARR["gapMs"] / 1000


# --------------------------------------------------------------------------------------------- recording helpers
def record(name: str, url: str, seconds: float, ready: str | None = None, actions=None, init: dict | None = None) -> None:
    """Record one clip. The time between context start and `ready` is trimmed away later."""
    from playwright.sync_api import sync_playwright

    CLIPS.mkdir(parents=True, exist_ok=True)
    tmp = CLIPS / f"_{name}"
    shutil.rmtree(tmp, ignore_errors=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": W, "height": H}, record_video_dir=str(tmp), record_video_size={"width": W, "height": H}, color_scheme="dark")
        if init is not None:
            ctx.add_init_script(f"window.STAGE = {json.dumps(init)};")
        t0 = time.monotonic()
        page = ctx.new_page()
        page.goto(url)
        if ready:
            page.wait_for_selector(ready, timeout=60_000)
        page.wait_for_timeout(400)
        offset = time.monotonic() - t0
        if actions:
            actions(page, seconds)
        else:
            page.wait_for_timeout(int(seconds * 1000) + 300)
        video = page.video
        ctx.close()
        browser.close()
        src = Path(video.path())
    out = CLIPS / f"{name}.webm"
    shutil.move(str(src), out)
    shutil.rmtree(tmp, ignore_errors=True)
    (CLIPS / f"{name}.json").write_text(json.dumps({"offset": round(offset, 3), "seconds": seconds}))
    print(f"  recorded {name}: {seconds:.1f} s (+{offset:.1f} s lead-in trimmed)")


def smooth_scroll(page, y: int, hold_ms: int) -> None:
    page.evaluate(f"window.scrollTo({{ top: {y}, behavior: 'smooth' }})")
    page.wait_for_timeout(hold_ms)


# --------------------------------------------------------------------------------------------- capture (live)
def capture() -> None:
    """Run the demo on Tiramisu, keep its output as the terminal transcript, and record the live
    inspector while the mandate is still alive."""
    env_key = None
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("TACHO_DATA_KEY="):
            env_key = line.split("=", 1)[1].strip()
    pause = int(os.environ.get("TACHO_VIDEO_PAUSE", "150"))
    WORK.mkdir(parents=True, exist_ok=True)
    npm = "npm.cmd" if os.name == "nt" else "npm"
    proc = subprocess.Popen([npm, "run", "demo", "--", "--pause-before-revoke", str(pause)], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", env={**os.environ, "NO_COLOR": "1"})
    transcript: list[dict] = []
    paused = threading.Event()
    t0 = time.monotonic()

    def pump() -> None:
        assert proc.stdout
        for raw in proc.stdout:
            text = raw.rstrip("\n")
            transcript.append({"t": round(time.monotonic() - t0, 3), "text": text})
            print("   |", text)
            if "pausing" in text:
                paused.set()

    th = threading.Thread(target=pump, daemon=True)
    th.start()
    if not paused.wait(timeout=600):
        proc.kill()
        sys.exit("demo did not reach the pause")

    state = json.loads((ROOT / "demo" / "state.json").read_text())
    agent_addr = state["wallets"]["agent"]
    mandate = state["mandate"]["key"]
    issued = [i for i, e in enumerate(state["events"]) if e["action"] == "issue-mandate"]
    run_events = [e for e in state["events"][(issued[-1] if issued else 0):] if e.get("entityKey")]  # this run only
    allowed = [e for e in run_events if e["action"].startswith("record:allowed")]
    forged = [e for e in run_events if e["action"] == "forged-record"]
    k = f"?k={env_key}" if env_key else ""

    def inspector_actions(page, seconds: float) -> None:
        total = int(seconds * 1000)
        page.wait_for_timeout(int(total * 0.22))
        box = page.locator(".mandate .querybox-toggle").first
        if box.count():
            box.click()
        page.wait_for_timeout(int(total * 0.14))
        forged_panel = page.locator(".panel-bad").first
        if forged_panel.count():
            smooth_scroll(page, int(forged_panel.bounding_box()["y"]) + page.evaluate("window.scrollY") - 90, int(total * 0.2))
        recs = page.locator("table.records").last
        smooth_scroll(page, int(recs.bounding_box()["y"]) + page.evaluate("window.scrollY") - 140, int(total * 0.3))
        smooth_scroll(page, 0, int(total * 0.14))

    record("inspector", f"{APP}#/agent/{agent_addr}{k}", seg_seconds("inspector"), ready=".mandate .disc", actions=inspector_actions)
    v = seg_seconds("verify")
    if allowed:
        record("verify_ok", f"{APP}#/record/{allowed[0]['entityKey']}{k}", v * 0.58, ready=".checklist")
    if forged:
        record("verify_forged", f"{APP}#/record/{forged[0]['entityKey']}", v * 0.42, ready=".checklist")

    proc.wait(timeout=pause + 240)
    th.join(timeout=5)
    (WORK / "transcript.json").write_text(json.dumps(transcript, indent=1))
    print(f"  transcript: {len(transcript)} lines, mandate {mandate}")


# --------------------------------------------------------------------------------------------- stage scenes
def stage() -> None:
    url = (VIDEO / "stage.html").resolve().as_uri()
    transcript = json.loads((WORK / "transcript.json").read_text()) if (WORK / "transcript.json").exists() else []
    for seg in NARR["segments"]:
        kind, scene = seg["scene"].split(":")
        if kind != "stage":
            continue
        secs = seg_seconds(seg["id"])
        init = {"scene": scene, "durationMs": int(secs * 1000)}
        if scene == "terminal":
            init["transcript"] = transcript
        record(seg["id"], url, secs, ready=f"#{scene}.on", init=init)


# --------------------------------------------------------------------------------------------- assemble
def srt_time(t: float) -> str:
    ms = int(round(t * 1000))
    return f"{ms // 3_600_000:02}:{ms // 60_000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"


def assemble() -> None:
    durations = json.loads((WORK / "durations.json").read_text())
    gap = NARR["gapMs"] / 1000
    parts: list[Path] = []
    srt: list[str] = []
    clock = 0.0
    for seg in NARR["segments"]:
        sid = seg["id"]
        secs = durations[sid] + gap
        clips = [sid] if (CLIPS / f"{sid}.webm").exists() else []
        if sid == "verify":
            clips = [c for c in ("verify_ok", "verify_forged") if (CLIPS / f"{c}.webm").exists()]
        if not clips:
            sys.exit(f"missing clip for {sid}: run capture/stage first")
        share = secs / len(clips)
        for c in clips:
            meta = json.loads((CLIPS / f"{c}.json").read_text())
            out = WORK / f"part_{len(parts):02}_{c}.mp4"
            # trim the lead-in, hold the last frame if the clip is short, exact length, constant fps
            run([ffmpeg(), "-y", "-ss", f"{meta['offset']:.3f}", "-i", str(CLIPS / f"{c}.webm"), "-t", f"{share:.3f}",
                 "-vf", f"tpad=stop_mode=clone:stop_duration=10,fps={FPS},scale={W}:{H}:flags=lanczos,format=yuv420p",
                 "-t", f"{share:.3f}", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", str(out)])
            parts.append(out)
        # captions: one cue per sentence, timed by length within the segment's speech
        sentences = [s.strip() for s in re.split(r"(?<=[.?!])\s+", seg["text"]) if s.strip()]
        total_chars = sum(len(s) for s in sentences)
        t = clock
        for s in sentences:
            dt = durations[sid] * len(s) / total_chars
            srt.append(f"{len(srt) + 1}\n{srt_time(t)} --> {srt_time(t + dt - 0.05)}\n{s}\n")
            t += dt
        clock += secs

    (WORK / "list.txt").write_text("".join(f"file '{p.name}'\n" for p in parts))
    run([ffmpeg(), "-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "video.mp4"], cwd=WORK)

    # voice track: each segment followed by the gap
    alist = []
    for seg in NARR["segments"]:
        alist.append(f"file 'audio/{seg['id']}.wav'\n")
        silence = WORK / "audio" / "gap.wav"
        if not silence.exists():
            run([ffmpeg(), "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", f"{gap:.3f}", str(silence)])
        alist.append("file 'audio/gap.wav'\n")
    (WORK / "alist.txt").write_text("".join(alist))
    run([ffmpeg(), "-y", "-f", "concat", "-safe", "0", "-i", "alist.txt", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "voice.wav"], cwd=WORK)

    (WORK / "captions.srt").write_text("\n".join(srt), encoding="utf-8")
    style = "FontName=Segoe UI,FontSize=15,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=4,Outline=0,Shadow=0,MarginV=28"
    run([ffmpeg(), "-y", "-i", "video.mp4", "-i", "voice.wav", "-vf", f"subtitles=captions.srt:force_style='{style}'",
         "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
         "-shortest", "-movflags", "+faststart", "tacho-demo.mp4"], cwd=WORK)
    final = WORK / "tacho-demo.mp4"
    print(f"  {final} ({final.stat().st_size / 1e6:.1f} MB, {clock:.1f} s)")
    shutil.copy(WORK / "captions.srt", VIDEO / "captions.en.srt")


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    steps = {"tts": [tts], "capture": [capture], "stage": [stage], "assemble": [assemble], "all": [tts, capture, stage, assemble]}[step]
    for fn in steps:
        print(f"== {fn.__name__}")
        fn()
