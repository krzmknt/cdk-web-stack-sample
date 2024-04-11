# レート制限迂回のため public.ecr  を使用
FROM public.ecr.aws/nginx/nginx:stable-alpine

# Nginx の設定ファイルをコンテナにコピー
COPY ./default.conf /etc/nginx/conf.d/

# カスタムスクリプトをコンテナにコピー
# このスクリプトはコンテナが起動するときに実行される
COPY ./entrypoint /docker-entrypoint.d/custom-entrypoint.sh

# 実行権限を付与
RUN chmod +x /docker-entrypoint.d/custom-entrypoint.sh

# アプリケーションは 80 ポートでリッスン
EXPOSE 8080
