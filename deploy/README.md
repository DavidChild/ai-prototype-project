# 一键部署

适用于使用 `systemd` 的 Ubuntu、Debian、CentOS Stream 8/9、Rocky Linux、AlmaLinux 或其他提供 `apt`/`dnf` 的服务器。请先把完整项目源码上传或拉取到服务器；脚本必须在项目根目录对应的源码中执行。

> CentOS 7 自带 glibc 2.17，无法运行本项目要求的 Node.js 20.19+/22。脚本检测到 CentOS 7 会停止部署并给出升级提示，建议使用 CentOS Stream 9、Rocky Linux 9 或 AlmaLinux 9。

部署结构：

- Nginx 直接提供 `dist` 前端静态文件。
- Node/Vite 轻量生产进程仅监听 `127.0.0.1`，承载 MySQL 存储、登录、AI 代理和 Layrr 动态接口。
- systemd 负责开机启动、异常重启和日志收集。
- 每次部署创建独立版本目录，启动失败会自动恢复上一版本。

## 首次部署

```bash
cp deploy/deploy.env.example deploy/deploy.env
chmod 600 deploy/deploy.env
# 编辑域名、Let's Encrypt 邮箱和 MySQL 连接；加密密钥可自动生成
sudo DEPLOY_ENV_FILE="$PWD/deploy/deploy.env" bash deploy/deploy.sh
```

推荐使用上面的 `bash deploy/deploy.sh`。即使误用 `sh deploy/deploy.sh`，脚本也会自动重新进入 Bash 执行。

也可以直接通过环境变量执行：

```bash
sudo DOMAIN=prototype.example.com \
  MYSQL_HOST=127.0.0.1 \
  MYSQL_USER=root \
  MYSQL_PASSWORD='your-password' \
  MYSQL_DATABASE=db_proto \
  ENABLE_HTTPS=1 \
  LETSENCRYPT_EMAIL=admin@example.com \
  bash deploy/deploy.sh
```

`DOMAIN` 只填写域名或服务器 IP，例如 `prototype.example.com` 或 `192.0.2.10`，不要带 `http://` 和路径。申请 Let's Encrypt 证书前，必须先把域名 DNS 解析到服务器公网 IP，并在云安全组/防火墙中开放 TCP 80 和 443 端口。Let's Encrypt 不对这里配置的 IP 地址签发证书，因此使用 IP 部署时请设置 `ENABLE_HTTPS=0`。

需要同时支持根域名和 `www` 时，将根域名放入 `DOMAIN`，其他域名使用逗号或空格写入 `DOMAIN_ALIASES`。Nginx 和同一张 Let's Encrypt 证书都会包含这些域名，所有域名必须先完成 DNS 解析。

在 CentOS/Rocky/Alma 上，如果 firewalld 正在运行，脚本默认通过 `OPEN_FIREWALL=1` 自动开放 `http` 和 `https` 服务。云服务器安全组仍需在云平台控制台单独开放 80/443，脚本无法代替云安全组配置。

默认使用 `FRONTEND_MODE=prebuilt`：从仓库解压 `dist.zip`，并通过独立 lock 文件只安装 MySQL、认证、AI 代理和 Layrr 所需的轻量运行依赖，不在服务器执行前端构建。每次前端代码有变化时，必须先在开发机执行 `npm run build`，重新压缩完整 `dist/` 为 `dist.zip` 并提交。脚本会验证 ZIP 路径和必要入口文件。需要在服务器构建时可改为 `FRONTEND_MODE=build`。

依赖安装仍需要一定内存。预构建模式默认要求“物理内存 + Swap”不少于 2GB，不足时创建并持久启用 2GB `/var/lib/xiaodou-prototype/build.swap`；服务器构建模式默认要求 4GB。可以通过 `MIN_BUILD_MEMORY_MB`、`BUILD_SWAP_SIZE_MB` 和 `SWAP_FILE` 调整；设置 `BUILD_SWAP_SIZE_MB=0` 会禁止自动创建 Swap。

脚本会自动安装 Nginx、Node.js 22、MySQL 客户端、`rsync`、`unzip` 和 Certbot，创建数据库（数据库表由应用启动时自动建立）、部署预构建前端、安装 systemd 服务并执行前后端健康检查。启用 HTTPS 时，脚本使用 HTTP Webroot 校验申请证书，签发后自动启用 HTTPS、HTTP 301 跳转和证书续期 reload hook。在启用 SELinux 的发行版上，脚本也会开放 Nginx 访问本机 Node 服务和前端构建目录所需的权限。

MySQL 服务本身需已安装并可连接；数据库不在本机时，将 `MYSQL_HOST` 改为实际地址。如果数据库账号没有建库权限，请预先创建 `db_proto` 并设置 `CREATE_DATABASE=0`。

## 更新部署

拉取新代码后重复执行同一条命令即可。服务端会从 `/etc/xiaodou-prototype.env` 读取并保留已有数据库配置和加密密钥；也可以继续传入 `DEPLOY_ENV_FILE` 覆盖配置。

## 常用命令

```bash
systemctl status xiaodou-prototype
journalctl -u xiaodou-prototype -f
systemctl restart xiaodou-prototype
nginx -t
```

证书续期可手动验证：

```bash
certbot renew --dry-run
systemctl list-timers | grep certbot
```

## 生成的文件

- 应用版本：`/opt/xiaodou-prototype/releases/<发布时间>`
- 当前版本软链接：`/opt/xiaodou-prototype/current`
- 服务环境变量：`/etc/xiaodou-prototype.env`（权限 `0640`）
- Nginx 配置：`/etc/nginx/conf.d/xiaodou-prototype.conf`
- Nginx 路由片段：`/etc/nginx/snippets/xiaodou-prototype-locations.conf`
- systemd 服务：`/etc/systemd/system/xiaodou-prototype.service`
- 证书续期 Hook：`/etc/letsencrypt/renewal-hooks/deploy/xiaodou-prototype-nginx.sh`

不要把 `deploy/deploy.env` 提交到 Git；它已加入 `.gitignore`。
