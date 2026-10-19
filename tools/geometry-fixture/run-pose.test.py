"""Offline exercise of run-pose.py: argument parsing, manifest reading, frame
decoding, and the full main() loop with a stubbed Ultralytics.

Run it directly, or through `run-pose.test.mjs` with the rest of the tools
suite. Needs Pillow, which the script itself needs to decode a frame.
"""

import atexit
import base64
import importlib.util
import io
import json
import shutil
import sys
import tempfile
import types
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name("run-pose.py")
TMP = Path(tempfile.mkdtemp(prefix="run-pose-test-"))
atexit.register(shutil.rmtree, TMP, True)

spec = importlib.util.spec_from_file_location("run_pose", SCRIPT)
run_pose = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run_pose)

checks = 0
failures = []


def check(name, condition, detail=""):
    global checks

    checks += 1

    if condition:
        print(f"PASS {name}")
    else:
        failures.append(f"{name} {detail}")
        print(f"FAIL {name} {detail}")


def jpeg_base64(width, height):
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (10, 20, 30)).save(buffer, format="JPEG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


# ---------------------------------------------------------------- arg parsing
args = run_pose.parse_args(
    ["--frames-jsonl", "a/frames.jsonl", "--output", "b/raw-pose.jsonl"]
)
check("parse --frames-jsonl", args.frames_jsonl == Path("a/frames.jsonl"))
check("parse --frames-jsonl leaves --frames-dir unset", args.frames_dir is None)
check("parse defaults model", args.model == "yolov8m-pose.pt")
check("parse defaults confidence", args.confidence == 0.25)

args = run_pose.parse_args(["--frames-dir", "a", "--output", "b.jsonl"])
check("parse --frames-dir", args.frames_dir == Path("a"))
check("parse --frames-dir leaves --frames-jsonl unset", args.frames_jsonl is None)

for argv, label in (
    (["--output", "b.jsonl"], "neither frame source"),
    (
        ["--frames-dir", "a", "--frames-jsonl", "f.jsonl", "--output", "b.jsonl"],
        "both frame sources",
    ),
    (["--frames-jsonl", "f.jsonl"], "missing --output"),
):
    try:
        run_pose.parse_args(argv)
        check(f"rejects {label}", False, "no SystemExit")
    except SystemExit as error:
        check(f"rejects {label}", error.code == 2, f"exit {error.code}")

# ------------------------------------------------------------ manifest reading
frames_jsonl = TMP / "frames.jsonl"
batch = {
    "schema": "supervision-js.tools.sam3-fixture.frame-batch",
    "version": 2,
    "startFrameIndex": 0,
    "count": 2,
    "quality": 0.92,
    "frames": [
        {
            "schema": "supervision-js.tools.sam3-fixture.extracted-frame",
            "version": 2,
            "frameIndex": index,
            "mediaTime": index / 25,
            "endTime": (index + 1) / 25,
            "width": 16,
            "height": 9,
            "image": {
                "type": "base64",
                "mimeType": "image/jpeg",
                "value": jpeg_base64(16, 9),
            },
            "jpegBase64": jpeg_base64(16, 9),
        }
        for index in (0, 1)
    ],
}
single = dict(batch["frames"][0])
single["frameIndex"] = 2
array_line = [dict(batch["frames"][0], frameIndex=3)]
data_url = dict(
    batch["frames"][0],
    frameIndex=4,
    jpegBase64=None,
    image={
        "type": "base64",
        "mimeType": "image/jpeg",
        "value": f"data:image/jpeg;base64,{jpeg_base64(16, 9)}",
    },
)
del data_url["jpegBase64"]

frames_jsonl.write_text(
    "\n".join(
        [
            json.dumps(batch),
            "",
            json.dumps(single),
            json.dumps(array_line),
            json.dumps(data_url),
        ]
    )
    + "\n",
    encoding="utf-8",
)

read = list(run_pose.read_extracted_frames(frames_jsonl))
check("reads every frame of every line shape", [index for index, _ in read] == [0, 1, 2, 3, 4], read and [i for i, _ in read])
check("skips blank lines", len(read) == 5, len(read))
check(
    "strips the data URL prefix",
    not read[4][1].startswith("data:") and read[4][1] == jpeg_base64(16, 9),
)
check("prefers jpegBase64 when present", read[0][1] == jpeg_base64(16, 9))

for bad, label in (
    ({"frameIndex": 0}, "frame without image data"),
    ({"image": {"value": "x"}}, "frame without frameIndex"),
    ({"frameIndex": -1, "jpegBase64": "x"}, "negative frameIndex"),
    ("not-an-object", "non-object frame"),
):
    try:
        run_pose.read_extracted_frame(bad)
        check(f"rejects {label}", False, "no ValueError")
    except ValueError:
        check(f"rejects {label}", True)

# ---------------------------------------------------------------- decoding
image = run_pose.decode_frame_image(read[0][1])
check("decodes a frame to a JPEG image", image.format == "JPEG", image.format)
check("decodes at the extracted size", image.size == (16, 9), image.size)

# ------------------------------------------------------------------- main()
class FakeTensor:
    def __init__(self, value):
        self.value = value

    def tolist(self):
        return self.value


class FakeBoxes:
    xyxy = FakeTensor([[1.234, 2.345, 3.456, 4.567]])
    conf = FakeTensor([0.987654])


class FakeKeypoints:
    xy = FakeTensor([[[1.11, 2.22]] * 17])
    conf = FakeTensor([[0.5432] * 17])


class FakeResult:
    boxes = FakeBoxes()
    keypoints = FakeKeypoints()


seen = []


class FakeYOLO:
    def __init__(self, model):
        self.ckpt_path = str(TMP / "yolov8m-pose.pt")
        Path(self.ckpt_path).write_bytes(b"weights")

    def predict(self, source, conf, device, verbose):
        seen.append((type(source).__name__, conf, device))
        return [FakeResult()]


ultralytics = types.ModuleType("ultralytics")
ultralytics.YOLO = FakeYOLO
ultralytics.__version__ = "8.3.0"
torch = types.ModuleType("torch")
torch.__version__ = "2.5.0"
sys.modules["ultralytics"] = ultralytics
sys.modules["torch"] = torch

output = TMP / "raw-pose.jsonl"
sys.argv = [
    "run-pose.py",
    "--frames-jsonl",
    str(frames_jsonl),
    "--output",
    str(output),
]
check("main() succeeds over a frames.jsonl", run_pose.main() == 0)

lines = output.read_text(encoding="utf-8").strip().split("\n")
header = json.loads(lines[0])
check("writes one header plus one line per frame", len(lines) == 6, len(lines))
check(
    "header schema is the one create-geometry-fixture.mjs accepts",
    header["schema"] == "supervision-js.tools.geometry-fixture.raw-pose",
)
check("header counts every manifest frame", header["frameCount"] == 5, header["frameCount"])
check("header keeps the weights checksum", len(header["weightsSha256"]) == 64)
check(
    "header keeps generator versions",
    (header["torchVersion"], header["ultralyticsVersion"]) == ("2.5.0", "8.3.0"),
)
check(
    "frame records keep manifest frame indexes",
    [json.loads(line)["frameIndex"] for line in lines[1:]] == [0, 1, 2, 3, 4],
)
check(
    "detection shape matches the committed fixture",
    json.loads(lines[1])["detections"][0]
    == {
        "xyxy": [1.2, 2.3, 3.5, 4.6],
        "confidence": 0.9877,
        "keypoints": {
            "xy": [[1.1, 2.2]] * 17,
            "confidence": [0.5432] * 17,
        },
    },
    json.loads(lines[1])["detections"][0],
)
check(
    "every frame reaches the model as a decoded image",
    [name for name, _, _ in seen] == ["JpegImageFile"] * 5,
    [name for name, _, _ in seen],
)
check(
    "the confidence threshold reaches the model",
    all(conf == 0.25 and device == "cpu" for _, conf, device in seen),
)

# --------------------------------------------------------- directory fallback
frames_dir = TMP / "frames"
frames_dir.mkdir()
from PIL import Image

for index in (0, 1, 2):
    Image.new("RGB", (16, 9)).save(frames_dir / f"{index:06d}.png")

seen.clear()
dir_output = TMP / "raw-pose-dir.jsonl"
sys.argv = [
    "run-pose.py",
    "--frames-dir",
    str(frames_dir),
    "--output",
    str(dir_output),
]
check("main() still succeeds over a frames directory", run_pose.main() == 0)
dir_lines = dir_output.read_text(encoding="utf-8").strip().split("\n")
check("directory run counts its png files", json.loads(dir_lines[0])["frameCount"] == 3)
check(
    "directory run keeps zero-padded stems as frame indexes",
    [json.loads(line)["frameIndex"] for line in dir_lines[1:]] == [0, 1, 2],
)
check(
    "directory frames still reach the model as paths",
    [name for name, _, _ in seen] == ["PosixPath"] * 3,
    [name for name, _, _ in seen],
)

empty_dir = TMP / "empty"
empty_dir.mkdir()
sys.argv = ["run-pose.py", "--frames-dir", str(empty_dir), "--output", str(dir_output)]
check("empty directory exits non-zero", run_pose.main() == 1)

empty_jsonl = TMP / "empty.jsonl"
empty_jsonl.write_text("", encoding="utf-8")
sys.argv = [
    "run-pose.py",
    "--frames-jsonl",
    str(empty_jsonl),
    "--output",
    str(dir_output),
]
check("empty manifest exits non-zero", run_pose.main() == 1)

print()
print(f"{checks - len(failures)} of {checks} checks passed")
sys.exit(1 if failures else 0)
