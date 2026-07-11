const axios = require('axios');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const {
    CW_TOKEN, RENDER_API_KEY, SUPABASE_URL, SUPABASE_KEY, RENDER_OWNER_ID
} = process.env;

const REPO_CONFIG = {
    "min": "https://github.com/mino-hobby-pro/MIN-Tube-Pro",
    "choco": "https://github.com/kuru-bana/Choco-Tube-Plus"
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const cwApi = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': CW_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});
const renderApi = axios.create({
    baseURL: 'https://api.render.com/v1',
    headers: { Authorization: `Bearer ${RENDER_API_KEY}` }
});

// --- お掃除機能 (3日過ぎたサービスを削除) ---
async function cleanupOldServices() {
    const now = new Date().toISOString();
    const { data: targets } = await supabase
        .from('deploy_logs')
        .select('*')
        .lt('delete_at', now);

    if (targets) {
        for (const item of targets) {
            try {
                // Renderサービス削除
                await renderApi.delete(`/services/${item.render_service_id}`);
                // Chatworkメッセージ削除
                await cwApi.delete(`/rooms/${item.cw_room_id}/messages/${item.cw_message_id}`);
                // DBからレコード削除
                await supabase.from('deploy_logs').delete().eq('id', item.id);
                console.log(`Cleaned up: ${item.service_type}`);
            } catch (e) { console.error("Cleanup Error:", e.message); }
        }
    }
}
// 1時間に1回実行
setInterval(cleanupOldServices, 60 * 60 * 1000);

// --- メインロジック ---
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const event = req.body.webhook_event;
    if (!event || !event.body || !event.body.startsWith('/deploy')) return;

    const { account_id, body, room_id } = event;
    const repoKey = body.split(' ')[1];
    const repoUrl = REPO_CONFIG[repoKey];

    if (!repoUrl) {
        const list = Object.keys(REPO_CONFIG).join(', ');
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[info][title](?) 種類不明[/title]${list} から選んでください。[/info]`);
        return;
    }

    const today = new Date().toISOString().split('T')[0];
    const { data: logs } = await supabase.from('deploy_logs').select('*').eq('user_id', account_id.toString()).eq('deployed_at', today);
    if (logs && logs.length > 0) {
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}]\n[info][title](stop) 1日1回まで[/title]本日はすでにデプロイ済みです。また明日！[/info]`);
        return;
    }

    const startMsg = await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}]\n[info][title](dance) 了解しました！[/title]「${repoKey}」を構築します。[hr]完了まで数分かかります。出来上がったらこのメッセージを書き換えますね！(コーヒー)[/info]`);
    const cw_msg_id = startMsg.data.message_id;

    try {

        const serviceName = `${repoKey}-${account_id}-${Date.now()}`.substring(0, 30);
        const createRes = await renderApi.post('/services', {
            name: serviceName,
            ownerId: RENDER_OWNER_ID,
            type: 'web_service',
            repo: repoUrl,
            autoDeploy: 'no',
            serviceDetails: { env: 'node', region: 'oregon', plan: 'free' }
        });

        const serviceId = createRes.data.id;
        const deployUrl = createRes.data.url;
        const deleteAt = new Date();
        deleteAt.setDate(deleteAt.getDate() + 3); 
        await supabase.from('deploy_logs').insert([{
            user_id: account_id.toString(),
            service_type: repoKey,
            render_service_id: serviceId,
            cw_message_id: cw_msg_id,
            cw_room_id: room_id.toString(),
            delete_at: deleteAt.toISOString()
        }]);

    
        setTimeout(async () => {
            await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, 
                `body=[rp aid=${account_id} to=${room_id}]\n[info][title](cracker) ${repoKey.toUpperCase()} 完了！ (cracker)[/title]お待たせしました！(shiny)\n専用URLを発行しました。[hr]🌐 URL:\n${deployUrl}\n\n⚠️ このURLとメッセージは3日後に自動削除されます。[/info]`);
        }, 30000); 

    } catch (err) {
        console.error(err);
        await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, `body=[info][title](shock) エラー[/title]作成に失敗しました。時間をおいて試してください。[/info]`);
    }
});

app.listen(process.env.PORT || 3000);
