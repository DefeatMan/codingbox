FROM node:24-slim AS frontend
WORKDIR /build/web
COPY third_party/wede/web/package*.json ./
RUN npm ci
COPY third_party/wede/web/ ./
COPY third_party/wede/backend /build/backend
COPY docker/patch-wede.mjs /opt/codingbox/patch-wede.mjs
COPY docker/wede /opt/codingbox/wede
COPY public/icon.svg /opt/codingbox/icon.svg
RUN node /opt/codingbox/patch-wede.mjs /build /opt/codingbox/icon.svg
RUN npm run build

FROM golang:1.25 AS backend
WORKDIR /build
COPY third_party/wede/ ./
COPY --from=frontend /build/backend/internal/lsp/lsp.go ./backend/internal/lsp/lsp.go
COPY --from=frontend /build/backend/internal/terminal ./backend/internal/terminal
COPY --from=frontend /build/backend/internal/collabdoc ./backend/internal/collabdoc
COPY --from=frontend /build/backend/internal/interview ./backend/internal/interview
COPY --from=frontend /build/backend/cmd/wede/main.go ./backend/cmd/wede/main.go
COPY --from=frontend /build/web/dist ./backend/cmd/wede/dist
COPY third_party/wede/site ./backend/cmd/wede/site
RUN CGO_ENABLED=0 go build -mod=vendor -tags embed_frontend -ldflags='-s -w -X main.Version=codingbox-0.0.1' -o /out/wede ./backend/cmd/wede
RUN GOBIN=/out go install golang.org/x/tools/gopls@v0.20.0

FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates procps \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/python \
    && /opt/python/bin/pip install --no-cache-dir 'python-lsp-server==1.12.2' 'pyflakes==3.4.0' \
    && npm install -g 'typescript@5.9.3' 'typescript-language-server@4.4.1' 'tsx@4.20.6' \
    && userdel node && useradd --create-home --uid 1000 --shell /bin/bash coder
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::https::Timeout=30 install -y --no-install-recommends curl g++ clangd \
    && rm -rf /var/lib/apt/lists/*
COPY --from=backend /out/wede /out/gopls /usr/local/bin/
COPY --from=backend /usr/local/go /usr/local/go
COPY docker/install-rust.sh /opt/codingbox/install-rust.sh
RUN sh /opt/codingbox/install-rust.sh
COPY docker/entrypoint.py /opt/codingbox/entrypoint.py
COPY templates /opt/codingbox/templates
ENV PATH="/opt/rust/bin:/opt/python/bin:/usr/local/go/bin:${PATH}" HOME=/home/coder
RUN mkdir -p /home/coder/project /home/coder/.wede && chown -R coder:coder /home/coder
USER coder
WORKDIR /home/coder
EXPOSE 9090
ENTRYPOINT ["python3", "/opt/codingbox/entrypoint.py"]
