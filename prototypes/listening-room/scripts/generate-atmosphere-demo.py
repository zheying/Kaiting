"""生成原型专用的原创循环片段，不读取任何曲库文件。"""
from array import array
from pathlib import Path
import math
import random
import wave

RATE = 22050
BEAT = 0.6
DURATION = BEAT * 64
samples = [0.0] * round(RATE * DURATION)
rng = random.Random(930)


def tone(start, duration, frequency, amplitude, kind="pluck"):
    begin = round(start * RATE)
    for index in range(round(duration * RATE)):
        target = begin + index
        if target >= len(samples):
            break
        t = index / RATE
        if kind == "kick":
            phase = 2 * math.pi * (45 * t + 12 * (1 - math.exp(-t * 28)))
            value = math.sin(phase) * math.exp(-t * 17)
        elif kind == "noise":
            value = rng.uniform(-1, 1) * math.exp(-t * 45)
        else:
            envelope = min(1, t * 160) * math.exp(-t * (3.5 if kind == "pluck" else 2.1))
            value = (math.sin(2 * math.pi * frequency * t) + .2 * math.sin(4 * math.pi * frequency * t)) * envelope
        samples[target] += value * amplitude


roots = [55.0, 65.406, 48.999, 73.416]
melody = [0, 7, 12, 3, 7, 14, 10, 7]
for bar in range(16):
    root = roots[(bar // 2) % 4]
    breakdown = 8 <= bar < 12
    for beat in range(4):
        start = (bar * 4 + beat) * BEAT
        if not breakdown or beat == 0:
            tone(start, .38, 0, .55 if not breakdown else .25, "kick")
        if not breakdown and beat in [1, 3]:
            tone(start, .18, 0, .16, "noise")
            tone(start, .2, 185, .05)
        tone(start + BEAT * .5, .12, 0, .055 if not breakdown else .018, "noise")
        tone(start, .55, root, .19 if not breakdown else .11, "bass")
        note = root * 4 * 2 ** (melody[(bar * 4 + beat) % 8] / 12)
        tone(start + BEAT * .5, 1.3, note, .095)
    for semitones in [0, 3, 7]:
        tone(bar * 4 * BEAT, 2.4, root * 2 * 2 ** (semitones / 12), .048, "bass")

peak = max(abs(sample) for sample in samples)
pcm = array("h")
for index, sample in enumerate(samples):
    fade = min(1, index / (RATE * .02), (len(samples) - 1 - index) / (RATE * .04))
    pcm.append(round(sample / peak * .62 * fade * 32767))
if __import__("sys").byteorder != "little":
    pcm.byteswap()
destination = Path(__file__).resolve().parent.parent / "public/audio/atmosphere-demo.wav"
destination.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(destination), "wb") as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(RATE)
    output.writeframes(pcm.tobytes())
print(f"原创演示片段：{DURATION:.1f} 秒，{destination.name}")
