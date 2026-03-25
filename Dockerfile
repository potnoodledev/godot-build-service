FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    wget unzip python3 git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
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

# Install pi coding agent
RUN npm install -g @mariozechner/pi-coding-agent

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install

COPY . /app

# Pre-import template so first build is faster
RUN cp -r /app/template /tmp/prebuild \
    && echo 'extends Node2D' > /tmp/prebuild/main.gd \
    && godot --headless --path /tmp/prebuild --import 2>&1 || true \
    && rm -rf /tmp/prebuild

RUN mkdir -p /workspace

EXPOSE 8080
CMD ["node", "server.js"]
