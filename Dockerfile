FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    wget unzip python3 python3-pip git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Godot 4.6.1 headless
ENV GODOT_VERSION=4.6.1
RUN wget -q https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}-stable/Godot_v${GODOT_VERSION}-stable_linux.x86_64.zip \
    && unzip Godot_v${GODOT_VERSION}-stable_linux.x86_64.zip \
    && mv Godot_v${GODOT_VERSION}-stable_linux.x86_64 /usr/local/bin/godot \
    && chmod +x /usr/local/bin/godot \
    && rm *.zip

# Install web export templates
RUN mkdir -p /root/.local/share/godot/export_templates/${GODOT_VERSION}.stable \
    && wget -q https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}-stable/Godot_v${GODOT_VERSION}-stable_export_templates.tpz \
    && unzip Godot_v${GODOT_VERSION}-stable_export_templates.tpz \
    && mv templates/* /root/.local/share/godot/export_templates/${GODOT_VERSION}.stable/ \
    && rm -rf templates *.tpz

WORKDIR /app
COPY requirements.txt .
RUN pip3 install --break-system-packages -r requirements.txt

COPY . /app

# Pre-import template so first build is faster
RUN cp -r /app/template /tmp/prebuild \
    && echo 'extends Node2D' > /tmp/prebuild/main.gd \
    && godot --headless --path /tmp/prebuild --import 2>&1 || true \
    && rm -rf /tmp/prebuild

EXPOSE 8080
CMD ["gunicorn", "-b", "0.0.0.0:8080", "-w", "2", "--timeout", "120", "server:app"]
