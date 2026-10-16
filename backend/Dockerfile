# ============================================================
# 阶段一：构建前端（CRA）
# ============================================================
FROM node:18-alpine AS frontend-build
WORKDIR /fe

# 先装依赖（利用缓存层）
# --legacy-peer-deps：前端 ajv@6 / ajv-keywords@3 与 react-scripts 的 ajv@8 存在 peer 冲突，
# 不加该参数 npm ci 会直接失败
COPY frontend/package*.json ./
RUN npm ci --legacy-peer-deps

# 高德地图 Key 通过构建参数注入（.dockerignore 排除了 .env，无法在构建期从文件读取）
# 由 docker-compose.yml 的 build.args 从根目录 .env 传入；不配置时地图区域显示占位
ARG REACT_APP_AMAP_KEY=""
ARG REACT_APP_AMAP_SECURITY_CODE=""
ENV REACT_APP_AMAP_KEY=$REACT_APP_AMAP_KEY
ENV REACT_APP_AMAP_SECURITY_CODE=$REACT_APP_AMAP_SECURITY_CODE

# 拷贝源码并构建
COPY frontend/ ./
RUN npm run build

# ============================================================
# 阶段二：后端（托管前端产物，单端口部署）
# ============================================================
FROM node:18-alpine
WORKDIR /app

# 后端依赖（tsc 构建需要 devDependencies，构建完成后裁剪）
COPY backend/package*.json ./
RUN npm ci --legacy-peer-deps

# 拷贝源码并构建
COPY backend/ ./
RUN npm run build && npm prune --production

# 前端构建产物（express.static 托管，一个端口同时服务页面与 API）
ENV STATIC_DIR=/app/frontend-build
COPY --from=frontend-build /fe/build /app/frontend-build

# 暴露端口（3001 HTTP 页面+API / 1883 内置 MQTT Broker）
EXPOSE 3001 1883

# 启动应用
CMD ["npm", "start"]
