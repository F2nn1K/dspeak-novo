FROM pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/voicelock
COPY . .

RUN python -c "import sys; assert sys.version_info[:2] == (3, 11), sys.version" \
    && python -m pip install --upgrade pip \
    && python -m pip install -e ".[export,evaluation]" \
    && chmod +x cloud/run_training.sh

CMD ["bash", "cloud/run_training.sh"]
