# ClusterFuzzLite build image — OpenSSF Scorecard detects fuzzing via this file.
# Uses the OSS-Fuzz JavaScript base builder (Jazzer.js), which provides
# `compile_javascript_fuzzer`. See build.sh for the fuzz targets.
# Digest-pinned (Scorecard Pinned-Dependencies); dependabot's docker ecosystem
# refreshes the pin so it tracks upstream instead of rotting.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:0d2d18019500c5b4b00c3edb37a5a3b8291fd9b43a19932a3dabb75e3f66f64d
COPY . $SRC/deepdive
WORKDIR $SRC/deepdive
COPY .clusterfuzzlite/build.sh $SRC/build.sh
