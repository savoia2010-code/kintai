# 勤務・活動記録（kintai）

裁量労働制向けの勤務・活動記録アプリ。ブラウザだけで動く単一の `index.html` と、
記録の保存・Chatwork 通知を行う Google Apps Script（`gas/`）で構成されています。

- 記録はブラウザの `localStorage` に保存されます（端末ごと・URLごとに別管理）
- GAS のデプロイ URL と合言葉は、アプリの **設定タブ** で入力します（コードには含めません）
- 端末を替えるときは 設定タブ → **バックアップ** で書き出し／取り込み、または **GASから復元** を使います

## GAS 側の準備

1. `gas/コード.js` を Apps Script プロジェクトに配置し、ウェブアプリとしてデプロイ
   （実行ユーザー: 自分 / アクセス: 全員）
2. スクリプトプロパティを設定

   | プロパティ | 内容 |
   |---|---|
   | `SPREADSHEET_ID` | 記録先スプレッドシートの ID |
   | `WORKER_NAME` | シート名に使う名前（`{WORKER_NAME}/{YY}/{MM}`） |
   | `CHATWORK_TOKEN` | Chatwork API トークン |
   | `CHATWORK_ROOM_ID` | 送信先ルーム ID |
   | `ACCESS_KEY` | アプリからの読み書きに必要な合言葉 |

3. デプロイ URL と `ACCESS_KEY` を、アプリの設定タブに入力

`ACCESS_KEY` が一致しないリクエストは、読み取り（`doGet`）・書き込み（`doPost`）ともに拒否されます。

## ローカルで動かす

`起動.bat`（Windows）または `起動.command`（Mac）をダブルクリックすると
`http://localhost:8080` で開きます。GitHub Pages 等の静的ホスティングにそのまま置くこともできます。
