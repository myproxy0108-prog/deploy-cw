const axios = require('axios');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const {
    CW_TOKEN, SUPABASE_URL, SUPABASE_KEY, RENDER_KEYS
} = process.env;

const REPO_CONFIG = {
    "tube": "https://github.com/mino-hobby-pro/MIN-Tube-Pro",
    "mirror": "https://github.com/myproxy0108-prog/Cloud-moon-mirror"
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const cwApi = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': CW_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});

// ロードされたアカウント情報
let ACCOUNTS = [];

// --- 起動時にAPIキーからOwnerIDを自動取得 ---
async function initAccounts() {
    const keys = RENDER_KEYS ? RENDER_KEYS.split(',') : [];
    const loadedAccounts = [];
    for (const key of keys) {
        try {
            const res = await axios.get('https://api.render.com/v1/owners', {
                headers: { Authorization: `Bearer ${key.trim()}` }
            });
            // 最初のOwnerIDを取得
            const ownerId = res.data[0].owner.id;
            loadedAccounts.push({ key: key.trim(), owner: ownerId });
            console.log(`✅ Account Loaded: ${ownerId}`);
        } catch (e) {
            console.error(`❌ Key Invalid: ${key.substring(0, 10)}...`);
        }
    }
    ACCOUNTS = loadedAccounts;
}

// --- 3日経過したサービスとお知らせを削除 ---
async function cleanupOldServices() {
    const now = new Date().toISOString();
    const { data: targets } = await supabase.from('deploy_logs').select('*').lt('delete_at', now);
    
    if (targets && targets.length > 0) {
        for (const item of targets) {
            try {
                const acc = ACCOUNTS.find(a => a.owner === item.render_owner_id);
                if (acc) {
                    // Renderサービス削除
                    await axios.delete(`https://api.render.com/v1/services/${item.render_service_id}`, {
                        headers: { Authorization: `Bearer ${acc.key}` }
                    });
                }
                // Chatworkメッセージ削除
                await cwApi.delete(`/rooms/${item.cw_room_id}/messages/${item.cw_message_id}`);
                // DBから削除
                await supabase.from('deploy_logs').delete().eq('id', item.id);
                console.log(`🗑️ Deleted: ${item.service_type} for ${item.user_name}`);
            } catch (e) {
                console.error("Cleanup Error:", e.message);
                await supabase.from('deploy_logs').delete().eq('id', item.id);
            }
        }
    }
}
setInterval(cleanupOldServices, 60 * 60 * 1000); // 1時間おきに掃除

// --- メイン：Webhook処理 ---
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const event = req.body.webhook_event;
    if (!event || !event.body || !event.body.startsWith('/deploy')) return;

    const { account_id, body, room_id } = event;
    const user_name = event.from_account_id_name || "名無し";
    const repoKey = body.split(' ')[1];
    const repoUrl = REPO_CONFIG[repoKey];

    if (!repoUrl || ACCOUNTS.length === 0) {
        await cwApi.post(`/rooms/${room_id}/messages`, `body=(shock) 種類が違うか、アカウントが読み込まれていません。`);
        return;
    }

    // 1. 1人1日1回制限チェック
    const today = new Date().toISOString().split('T')[0];
    const { data: logs } = await supabase.from('deploy_logs').select('*').eq('user_id', account_id.toString()).eq('deployed_at', today);
    if (logs && logs.length > 0) {
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}]\n[info][title](stop) 1日1回制限[/title]${user_name}さん、また明日作りにきてね！[/info]`);
        return;
    }

    // 2. 受付
    const startMsg = await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}]\n[info][title](dance) 了解です！[/title]「${repoKey}」をランダムなアカウントで構築します。(コーヒー)[hr]完了まで数分お待ちください...[/info]`);
    const cw_msg_id = startMsg.data.message_id;

    try {
        // 3. アカウントをランダム選択
        const account = ACCOUNTS[Math.floor(Math.random() * ACCOUNTS.length)];

        // 4. Renderで新規サービス作成
        const serviceName = `${repoKey}-${account_id}-${Date.now()}`.substring(0, 30);
        const createRes = await axios.post('https://api.render.com/v1/services', {
            name: serviceName,
            ownerId: account.owner,
            type: 'web_service',
            repo: repoUrl,
            autoDeploy: 'no',
            serviceDetails: { env: 'node', region: 'oregon', plan: 'free' }
        }, {
            headers: { Authorization: `Bearer ${account.key}` }
        });

        const serviceId = createRes.data.id;
        const deployUrl = createRes.data.url;
        const deleteAt = new Date();
        deleteAt.setDate(deleteAt.getDate() + 3);

        // 5. DB保存（OwnerIDも記録！）
        await supabase.from('deploy_logs').insert([{
            user_id: account_id.toString(),
            user_name: user_name,
            service_type: repoKey,
            render_service_id: serviceId,
            render_owner_id: account.owner,
            cw_message_id: cw_msg_id,
            cw_room_id: room_id.toString(),
            delete_at: deleteAt.toISOString()
        }]);

        // 6. 完了編集
        setTimeout(async () => {
            await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, 
                `body=[rp aid=${account_id} to=${room_id}]\n[info][title](cracker) ${repoKey.toUpperCase()} 完了！ (cracker)[/title]専用URLができました！(shiny)\n\n🌐 URL:\n${deployUrl}\n\n[hr]⚠️ 3日後にメッセージとサーバーは自動削除されます。[/info]`);
        }, 40000);

    } catch (err) {
        console.error(err.response?.data || err.message);
        await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, `body=[info][title](shock) エラー[/title]Renderの制限か、設定に問題があります。[/info]`);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Bot started on port ${PORT}`);
    await initAccounts(); // 起動時に全アカウントのOwnerIDを自動取得
});
