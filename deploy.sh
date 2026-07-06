#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$SCRIPT_DIR" || exit 1

python3 run.py

mkdir -p pages
cp -r main static all.json link.json errors.json pages/
# 将根绝对路径（/all.json, /link.json）改为相对路径，适配子路径部署
sed -i 's|/link\.json|link.json|g; s|/all\.json|all.json|g' pages/index.html

echo "===================================="
echo "静态文件已生成到 pages/ 目录"
echo "请将 pages/ 目录作为静态网站根目录部署"
echo "部署后检查 all.json 和 link.json 是否可访问"
echo "===================================="
