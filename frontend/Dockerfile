# 前端 Dockerfile - 多阶段构建
FROM node:18-alpine as build

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖（--legacy-peer-deps：ajv@6 与 react-scripts 的 ajv@8 存在 peer 冲突）
RUN npm ci --legacy-peer-deps

# 复制源代码
COPY . .

# 构建项目
RUN npm run build

# 生产环境 - 使用 Nginx
FROM nginx:alpine

# 复制构建产物到 Nginx
COPY --from=build /app/build /usr/share/nginx/html

# 复制 Nginx 配置
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 暴露端口
EXPOSE 80

# 启动 Nginx
CMD ["nginx", "-g", "daemon off;"]