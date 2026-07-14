const axios = require('axios');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const { CW_TOKEN, SUPABASE_URL, SUPABASE_KEY, RENDER_KEYS } = process.env;

const REPO_CONFIG = {
    "min": "https://github.com/myproxy0108-prog/MIN-Tube-Pro",
    "choco": "https://github.com/myproxy0108-prog/Choco-Tube-Plus"
};

// ★この行が消えていたためエラーになっていました！
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const cwApi = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': CW_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});

let ACCOUNTS = [];
const pendingDeploys = {};

// 日本時間の「今日」を出す関数
function getJstDate() {
    const now = new Date();
    const jstTime = now.getTime() + (9 * 60 * 60 * 1000);
    return new Date(jstTime).toISOString().split('T')[0];
}

// アカウント読み込み
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
            const ownerId = res.data[0].owner.id;
            loaded.push({ key, ownerId });
            console.log(`✅ アカウント読み込み成功: ${ownerId}`);
        } catch (e) {
            console.error(`❌ キーエラー: ${key.substring(0, 5)}...`);
        }
    }
    ACCOUNTS = loaded;
}

// 返信タグのお掃除
function cleanMessage(text) {
    return text.replace(/\[(rp aid=[0-9]+ to=[0-9\-]+|To:[0-9]+)\][^\n]*\n?/g, '').trim();
}

// 最強のお掃除関数（DBとRenderのズレを防ぐ）
async function cleanup() {
    const now = new Date().toISOString();
    const { data: targets } = await supabase.from('deploy_logs').select('*').lt('delete_at', now);
    
    if (!targets || targets.length === 0) return;

    for (const item of targets) {
        try {
            const acc = ACCOUNTS.find(a => a.ownerId === item.render_owner_id);
            if (acc) {
                await axios.delete(`https://api.render.com/v1/services/${item.render_service_id}`, {
                    headers: { Authorization: `Bearer ${acc.key}` }
                }).catch(e => console.log(`Render削除スキップ`));
            }
            await cwApi.delete(`/rooms/${item.cw_room_id}/messages/${item.cw_message_id}`)
                .catch(e => console.log(`CW削除スキップ`));
        } finally {
            await supabase.from('deploy_logs').delete().eq('id', item.id);
            console.log(`🧹 3日経過したサーバーを削除しました: ${item.service_type}`);
        }
    }
}
setInterval(cleanup, 1000 * 60 * 60);

// 冬眠防止
app.get('/', (req, res) => res.send('Bot is awake!'));

// Webhookのメイン処理
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    
    // 発言のたびにお掃除チェック
    cleanup();

    const event = req.body.webhook_event;
    if (!event || !event.body) return;

    const { account_id, body, room_id, message_id } = event;
    const user_name = event.from_account_id_name || "ユーザー";
    const bodyStr = cleanMessage(body);

    if (bodyStr === '/dl') {
        let listText = "";
        for (const [key, url] of Object.entries(REPO_CONFIG)) {
            const repoName = url.split('/').pop();
            listText += `■ ${key} \n  └ ${repoName}\n\n`;
        }
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]📝 作成可能なアプリ一覧[/title]以下の種類が指定できます。[hr]${listText}[hr]💡 使い方: 「/deploy tube」のように入力してください。[/info]`);
        return;
    }

    if (bodyStr.startsWith('/deploy')) {
        const repoKey = bodyStr.split(' ')[1];
        const repoUrl = REPO_CONFIG[repoKey];

        if (!repoUrl) {
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
        const repoUrl = REPO_CONFIG[repoKey];

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
    cleanup();
});
