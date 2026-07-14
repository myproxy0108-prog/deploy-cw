const axios = require('axios');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const { CW_TOKEN, SUPABASE_URL, SUPABASE_KEY, RENDER_KEYS } = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const cwApi = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': CW_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});

let ACCOUNTS = [];
let REPO_CONFIG = {}; // データベースから読み込んだリポジトリ一覧
const pendingDeploys = {};

// 日本時間の「今日」を出す関数
function getJstDate() {
    const now = new Date();
    const jstTime = now.getTime() + (9 * 60 * 60 * 1000);
    return new Date(jstTime).toISOString().split('T')[0];
}

// アカウントのOwnerID読み込み
async function initAccounts() {
    const keys = RENDER_KEYS ? RENDER_KEYS.split(',') : [];
    const loaded = [];
    for (const k of keys) {
        const key = k.trim();
        if (!key) continue;
        try {
            const res = await axios.get('https://api.render.com/v1/owners', {
                headers: { Authorization: `Bearer ${key}` }
            });
            loaded.push({ key, ownerId: res.data[0].owner.id });
        } catch (e) {
            console.error(`❌ キーエラー: ${key.substring(0, 5)}...`);
        }
    }
    ACCOUNTS = loaded;
}

// ★追加: DBからリポジトリ設定を読み込む
async function initRepos() {
    const { data, error } = await supabase.from('app_configs').select('*');
    if (!error && data && data.length > 0) {
        data.forEach(row => {
            REPO_CONFIG[row.repo_key] = { url: row.repo_url, description: row.description || "" };
        });
    } else {
        // 最初何もない時はデフォルトを入れてDBに保存しておく
        REPO_CONFIG = {
            "tube": { url: "https://github.com/mino-hobby-pro/MIN-Tube-Pro", description: "YouTubeクローン" },
            "mirror": { url: "https://github.com/myproxy0108-prog/Cloud-moon-mirror", description: "漫画ビューア" }
        };
        for (const [key, conf] of Object.entries(REPO_CONFIG)) {
            await supabase.from('app_configs').upsert({ repo_key: key, repo_url: conf.url, description: conf.description });
        }
    }
    console.log(`✅ リポジトリ設定読み込み完了`);
}

// ★追加: ChatworkのAPIを叩いて、発言者がルームの「管理者」か判定する関数
async function isAdmin(roomId, accountId) {
    try {
        const res = await cwApi.get(`/rooms/${roomId}/members`);
        const member = res.data.find(m => m.account_id === Number(accountId));
        return member && member.role === 'admin';
    } catch (e) {
        console.error("権限チェックエラー:", e.message);
        return false;
    }
}

// 返信タグ除去
function cleanMessage(text) {
    return text.replace(/\[(rp aid=[0-9]+ to=[0-9\-]+|To:[0-9]+)\][^\n]*\n?/g, '').trim();
}

// お掃除関数
async function cleanup() {
    const now = new Date().toISOString();
    const { data: targets } = await supabase.from('deploy_logs').select('*').lt('delete_at', now);
    if (!targets || targets.length === 0) return;
    for (const item of targets) {
        try {
            const acc = ACCOUNTS.find(a => a.ownerId === item.render_owner_id);
            if (acc) {
                await axios.delete(`https://api.render.com/v1/services/${item.render_service_id}`, { headers: { Authorization: `Bearer ${acc.key}` } }).catch(()=>{});
            }
            await cwApi.delete(`/rooms/${item.cw_room_id}/messages/${item.cw_message_id}`).catch(()=>{});
        } finally {
            await supabase.from('deploy_logs').delete().eq('id', item.id);
        }
    }
}
setInterval(cleanup, 1000 * 60 * 60);

// 冬眠防止
app.get('/', (req, res) => res.send('Bot is awake!'));

// Webhookメイン
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    cleanup();

    const event = req.body.webhook_event;
    if (!event || !event.body) return;

    const { account_id, body, room_id, message_id } = event;
    const user_name = event.from_account_id_name || "ユーザー";
    const bodyStr = cleanMessage(body);

    // ============================================
    // ★追加: /add-dl [名前] [URL] [説明]
    // ============================================
    if (bodyStr.startsWith('/add-dl ')) {
        if (!(await isAdmin(room_id, account_id))) {
            await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]🚫 権限エラー[/title]このコマンドはルームの管理者（Admin）のみ実行可能です！[/info]`);
            return;
        }
        
        // スペースで区切って取得
        const args = bodyStr.split(/ +/);
        const repoKey = args[1];
        const repoUrl = args[2];
        const description = args.slice(3).join(' '); // 3番目以降はすべて説明として繋げる

        if (!repoKey || !repoUrl) {
            await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]⚠️ 使い方[/title]/add-dl [あだ名] [GitHubのURL] [説明文(任意)][/info]`);
            return;
        }

        const { error } = await supabase.from('app_configs').upsert({ repo_key: repoKey, repo_url: repoUrl, description: description });
        if (error) {
            await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\nエラーが発生しました: ${error.message}`);
            return;
        }

        REPO_CONFIG[repoKey] = { url: repoUrl, description: description };
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]✅ 追加完了[/title]■ ${repoKey}\nURL: ${repoUrl}\n説明: ${description || "なし"}[/info]`);
        return;
    }

    // ============================================
    // ★追加: /remove-dl [名前]
    // ============================================
    if (bodyStr.startsWith('/remove-dl ')) {
        if (!(await isAdmin(room_id, account_id))) {
            await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]🚫 権限エラー[/title]このコマンドはルームの管理者（Admin）のみ実行可能です！[/info]`);
            return;
        }

        const repoKey = bodyStr.split(/ +/)[1];
        if (!repoKey || !REPO_CONFIG[repoKey]) {
            await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]⚠️ エラー[/title]「${repoKey}」は見つかりません。[/info]`);
            return;
        }

        const { error } = await supabase.from('app_configs').delete().eq('repo_key', repoKey);
        if (error) {
            await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\nエラーが発生しました: ${error.message}`);
            return;
        }

        delete REPO_CONFIG[repoKey];
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]🗑️ 削除完了[/title]「${repoKey}」を一覧から削除しました。[/info]`);
        return;
    }

    // ============================================
    // /dl コマンド
    // ============================================
    if (bodyStr === '/dl') {
        let listText = "";
        for (const [key, conf] of Object.entries(REPO_CONFIG)) {
            const repoName = conf.url.split('/').pop();
            const desc = conf.description ? `\n    └ 📝 ${conf.description}` : "";
            listText += `■ ${key} (${repoName})${desc}\n\n`;
        }
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]🚀 作成可能なアプリ一覧[/title]以下の種類が指定できます。[hr]${listText}[hr]💡 使い方: 「/deploy tube」のように入力してください。[/info]`);
        return;
    }

    // ============================================
    // /deploy コマンド
    // ============================================
    if (bodyStr.startsWith('/deploy')) {
        const repoKey = bodyStr.split(' ')[1];
        const repoConf = REPO_CONFIG[repoKey];

        if (!repoConf) {
            await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]⚠️ エラー[/title]「${repoKey}」は登録されていません。\n※ /dl で一覧を確認できます。[/info]`);
            return;
        }
        if (ACCOUNTS.length === 0) return;

        const todayJST = getJstDate();
        const { data: logs } = await supabase.from('deploy_logs').select('*').eq('user_id', account_id.toString()).eq('deployed_at', todayJST);
        
        if (logs && logs.length > 0) {
            await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title](stop) 制限[/title]今日はもう作っています！また明日（夜中0時リセット）お待ちしてます！[/info]`);
            return;
        }

        pendingDeploys[account_id] = { repoKey: repoKey, timestamp: Date.now() };
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]🔗 URLの設定[/title]どのようなURLにしますか？\nこのメッセージに【英数字とハイフンのみ】で返信してください。\n\n（例: abide と打つと abide-xxxx.onrender.com になります）[/info]`);
        return;
    }

    // ============================================
    // URL入力待ちからの返信
    // ============================================
    if (pendingDeploys[account_id]) {
        const pending = pendingDeploys[account_id];
        if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
            delete pendingDeploys[account_id];
            return; 
        }

        const customUrl = bodyStr;
        if (!/^[a-zA-Z0-9\-]+$/.test(customUrl)) {
            await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]⚠️ エラー[/title]「${customUrl}」には使えない文字が含まれています。\n英数字とハイフンのみでもう一度返信してください。[/info]`);
            return;
        }

        delete pendingDeploys[account_id];
        const repoKey = pending.repoKey;
        const repoUrl = REPO_CONFIG[repoKey].url;

        const startRes = await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title](dance) 準備中[/title]URLに「${customUrl}」を含めて構築を開始しました！\n少々お待ちを...[/info]`);
        const cw_msg_id = startRes.data.message_id;

        try {
            const acc = ACCOUNTS[Math.floor(Math.random() * ACCOUNTS.length)];
            const randomCode = Math.floor(1000 + Math.random() * 9000);
            const serviceName = `${customUrl.substring(0, 20)}-${randomCode}`.toLowerCase();

            const createRes = await axios.post('https://api.render.com/v1/services', {
                name: serviceName,
                ownerId: acc.ownerId,
                type: 'web_service',
                repo: repoUrl,
                autoDeploy: 'no',
                serviceDetails: { 
                    env: 'node', 
                    region: 'oregon', 
                    plan: 'free',
                    envSpecificDetails: { buildCommand: 'npm install', startCommand: 'npm start' }
                }
            }, { headers: { Authorization: `Bearer ${acc.key}` } });

            const serviceData = createRes.data.service || createRes.data;
            const serviceId = serviceData.id;
            const deployUrl = serviceData.serviceDetails?.url || serviceData.url || "URL取得エラー";

            if (!serviceId) throw new Error(`サービスIDが取得できませんでした`);

            const deleteAt = new Date();
            deleteAt.setDate(deleteAt.getDate() + 3);

            const { error: insError } = await supabase.from('deploy_logs').insert([{
                user_id: account_id.toString(),
                user_name,
                service_type: repoKey,
                deployed_at: getJstDate(),
                render_service_id: serviceId,
                render_owner_id: acc.ownerId,
                cw_message_id: cw_msg_id,
                cw_room_id: room_id.toString(),
                delete_at: deleteAt.toISOString()
            }]);

            if (insError) throw new Error(`Supabase Error: ${insError.message}`);

            setTimeout(async () => {
                await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, 
                    `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title](cracker) 完了！ (cracker)[/title]あなた専用のオリジナルURLです！(shiny)\n\n🌐 URL:\n${deployUrl}\n\n[hr]※3日後に自動で消えます。[/info]`);
            }, 45000);

        } catch (err) {
            const errMsg = err.response?.data?.message || err.message;
            console.error("詳細エラー:", errMsg);
            await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title](shock) エラー発生[/title]理由: ${errMsg}[/info]`);
        }
    }
});

app.listen(process.env.PORT || 3000, async () => {
    console.log(`Server started!`);
    await initAccounts();
    await initRepos(); // ★DBからリポジトリ情報をロード
    cleanup();
});
