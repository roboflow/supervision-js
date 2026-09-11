# Synthetic finite-video fixtures

These tiny videos contain FFmpeg-generated test patterns, no user footage.

Regenerate from the repository root (FFmpeg with libx264):

```sh
ffmpeg -f lavfi -i testsrc2=size=32x32:rate=5 -frames:v 12 -vf 'setpts=if(lt(N\,3)\,N/(5*TB)\,(N+5)/(5*TB))' -fps_mode vfr -c:v libx264 -bf 0 -video_track_timescale 30000 -movflags +faststart test/fixtures/video-duration/finite-vfr.mp4
ffmpeg -i test/fixtures/video-duration/finite-vfr.mp4 -c copy -output_ts_offset 2 -video_track_timescale 30000 -movflags +faststart test/fixtures/video-duration/offset-vfr.mp4
```

The first file has nonuniform packet timing and ends at 3.4 seconds. The second has a positive edit-list start at 2 seconds and packet end at 5.4 seconds, also a 3.4-second span. Tests alter only in-memory mdhd duration fields to create undercounted and overcounted headers; encoded samples and timing tables remain unchanged.
