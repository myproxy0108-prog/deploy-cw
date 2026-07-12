const axios = require('axios');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const { CW_TOKEN, SUPABASE_URL, SUPABASE_KEY, RENDER_KEYS } = process.env;

const REPO_CONFIG = {
    "tube": "https://github.com/mino-hobby-pro/MIN-Tube-Pro",
    "mirror": "https://github.com/myproxy0108-prog/Cloud-moon-mirror"
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const cwApi = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': CW_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});

let ACCOUNTS = [];

// 起動時に全アカウントのOwnerIDを取得
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
            // owner.idを正しく取得
            const ownerId = res.data[0].owner.id;
            loaded.push({ key, ownerId });
            console.log(`✅ Account Loaded: ${ownerId}`);
        } catch (e) {
            console.error(`❌ Key Error: ${e.message}`);
        }
    }
    ACCOUNTS = loaded;
}

// Webhook
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const event = req.body.webhook_event;
    if (!event || !event.body || !event.body.startsWith('/deploy')) return;

    const { account_id, body, room_id } = event;
    const user_name = event.from_account_id_name || "ユーザー";
    const repoKey = body.split(' ')[1];
    const repoUrl = REPO_CONFIG[repoKey];

    // エラーチェック: リポジトリ
    if (!repoUrl) {
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[info][title]⚠️[/title]${repoKey} は登録されていません。[/info]`);
        return;
    }

    // エラーチェック: アカウント読み込み
    if (ACCOUNTS.length === 0) {
        await cwApi.post(`/rooms/${room_id}/messages`, `body=Renderのアカウントが読み込めていません。環境変数 RENDER_KEYS を確認してください。`);
        return;
    }

    // 1日1回制限
    const today = new Date().toISOString().split('T')[0];
    const { data: logs, error: sbError } = await supabase.from('deploy_logs').select('*').eq('user_id', account_id.toString()).eq('deployed_at', today);
    
    if (logs && logs.length > 0) {
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}]\n制限：また明日！`);
        return;
    }

    const startRes = await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}]\n[info][title](dance) 準備中[/title]構築を開始しました。[/info]`);
    const cw_msg_id = startRes.data.message_id;

    try {
        const acc = ACCOUNTS[Math.floor(Math.random() * ACCOUNTS.length)];

        // Render API 実行
        const serviceName = `tmp-${repoKey}-${Date.now()}`.substring(0, 30);
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
                // 必要最低限の設定を追加
                numInstances: 1
            }
        }, { headers: { Authorization: `Bearer ${acc.key}` } });

        const serviceId = createRes.data.id;
        const deployUrl = createRes.data.url;
        const deleteAt = new Date();
        deleteAt.setDate(deleteAt.getDate() + 3);

        // Supabase保存
        const { error: insError } = await supabase.from('deploy_logs').insert([{
            user_id: account_id.toString(),
            user_name,
            service_type: repoKey,
            render_service_id: serviceId,
            render_owner_id: acc.ownerId,
            cw_message_id: cw_msg_id,
            cw_room_id: room_id.toString(),
            delete_at: deleteAt.toISOString()
        }]);

        if (insError) throw new Error(`Supabase Insert Error: ${insError.message}`);

        setTimeout(async () => {
            await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, 
                `body=[rp aid=${account_id} to=${room_id}]\n[info][title](cracker) 完了[/title]URL: ${deployUrl}\n3日後に消えます。[/info]`);
        }, 45000);

    } catch (err) {
        // エラーの詳細をChatworkに送る
        const errMsg = err.response?.data?.message || err.message;
        console.error("詳細エラー:", errMsg);
        await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, `body=[info][title](shock) エラー発生[/title]理由: ${errMsg}[/info]`);
    }
});

app.listen(process.env.PORT || 3000, async () => {
    await initAccounts();
});
