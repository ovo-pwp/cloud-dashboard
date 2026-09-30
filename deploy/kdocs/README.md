# 这个目录要放「抓取脚本 + 金山文档 Token」

服务器上的「立即同步」按钮 / 定时轮询，最终会调用这里的 `kdocs_pull.py` 去金山文档取数。

> **⚠️ 先读这一段（2026-09-29 更新）**
>
> **本机开发环境不需要本目录放 `kdocs_pull.py`。** 本机跑的是桌面那份唯一副本
> `C:\Users\Administrator\Desktop\看板模板\kdocs_pull.py`（见 `server/services/syncRunner.js`
> 的 `KDOCS_PULL` 默认值）。
>
> 本目录原来有一份 `kdocs_pull.py`，已于 2026-09-29 **删除** —— 它是旧副本，
> 缺一条业务规则（「备注含『无效订单』的行不计入已发货未开票看板」），
> 一旦被误用会让看板凭空多出 2 条单 / 25,476.86 元且不报任何错。
> 旧副本备份在 `.backup/20260929-1830/kdocs_pull.py.deploy-OLD`。
>
> **下面的内容只在「真的要把系统部署到服务器」时才需要执行。**
> 届时从桌面那份拷过来即可（务必拷最新版，不要用任何历史副本）。

## 需要放两个文件

| 文件 | 从哪来 | 说明 |
|---|---|---|
| `kdocs_pull.py` | 本机 `C:\Users\Administrator\Desktop\看板模板\kdocs_pull.py` | 抓取脚本。**只依赖 Python 标准库 + openpyxl**，镜像里已经装好 |
| `kdocs_token.txt` | 本机 `C:\Users\Administrator\Desktop\看板模板\kdocs_token.txt` | 金山文档访问 Token，一行纯文本 |

上传示例（在**本机**执行）：

```bash
scp "C:/Users/Administrator/Desktop/看板模板/kdocs_pull.py"    root@<服务器IP>:~/cloud-dashboard/deploy/kdocs/
scp "C:/Users/Administrator/Desktop/看板模板/kdocs_token.txt"  root@<服务器IP>:~/cloud-dashboard/deploy/kdocs/
```

## 注意

- **`kdocs_token.txt` 是敏感凭证**，不要提交到 git，也不要发到群里。已经在本目录的 `.gitignore` 里排除了。
- 目录权限建议收紧：`chmod 700 kdocs && chmod 600 kdocs/kdocs_token.txt`
- Token 会过期。失效时同步会报「金山文档凭证已失效（400006）」，重新获取后覆盖这个文件即可，**不用重启容器**（每次同步都是现读文件）。
- `kdocs_pull.py` 会在**本目录**写一份 `取数日志.log`，所以这里要可写（compose 挂载是可写的）。

## Token 怎么拿

和在本机用的时候是同一套流程。如果本机那份还有效，直接拷过来最省事。

## 不想在服务器上跑抓取？

也可以让同步继续在本机跑，只把结果推到服务器数据库 —— 见 `deploy/README.md` 的「方式二：本机抓取 + 推送」。
