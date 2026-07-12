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
            const ownerId = res.data[0].owner.id;
            loaded.push({ key, ownerId });
            console.log(`✅ アカウント読み込み成功: ${ownerId}`);
        } catch (e) {
            console.error(`❌ キーエラー: ${key.substring(0, 5)}...`);
        }
    }
    ACCOUNTS = loaded;
}

// Webhook処理
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const event = req.body.webhook_event;
    if (!event || !event.body) return;

    // ★修正ポイント1: eventから「元のメッセージID (message_id)」を取り出す
    const { account_id, body, room_id, message_id } = event;
    const bodyStr = body.trim();
    const user_name = event.from_account_id_name || "ユーザー";

    // ============================================
    // ★追加機能: /dl コマンドで作れるもの一覧を表示
    // ============================================
    if (bodyStr === '/dl') {
        let listText = "";
        for (const [key, url] of Object.entries(REPO_CONFIG)) {
            const repoName = url.split('/').pop(); // "MIN-Tube-Pro" などを取り出す
            listText += `■ ${key} \n  └ ${repoName}\n\n`;
        }
        
        // Chatworkの返信フォーマット: to=${room_id}-${message_id}
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]📝 作成可能なアプリ一覧[/title]以下の種類が指定できます。[hr]${listText}[hr]💡 使い方: 「/deploy tube」のように入力してください。[/info]`);
        return;
    }

    // /deploy コマンド以外は無視
    if (!bodyStr.startsWith('/deploy')) return;

    const repoKey = bodyStr.split(' ')[1];
    const repoUrl = REPO_CONFIG[repoKey];

    // エラー: 登録されていない種類の場合
    if (!repoUrl) {
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]⚠️ エラー[/title]「${repoKey}」は登録されていません。\n※ /dl で一覧を確認できます。[/info]`);
        return;
    }

    if (ACCOUNTS.length === 0) {
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\nエラー: Renderアカウントが読み込めていません。`);
        return;
    }

    // 1日1回制限
    const today = new Date().toISOString().split('T')[0];
    const { data: logs } = await supabase.from('deploy_logs').select('*').eq('user_id', account_id.toString()).eq('deployed_at', today);
    
    if (logs && logs.length > 0) {
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title](stop) 制限[/title]今日はもう作っています！また明日！[/info]`);
        return;
    }

    // ★修正ポイント2: すべての返信に -${message_id} を追加してリンクミスを解消
    const startRes = await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title](dance) 準備中[/title]構築を開始しました。少々お待ちを...[/info]`);
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
                envSpecificDetails: {
                    buildCommand: 'npm install',
                    startCommand: 'npm start'
                }
            }
        }, { headers: { Authorization: `Bearer ${acc.key}` } });

        const serviceData = createRes.data.service || createRes.data;
        const serviceId = serviceData.id;
        const deployUrl = serviceData.serviceDetails?.url || serviceData.url || "URL取得エラー";

        if (!serviceId) {
            throw new Error(`サービスIDが取得できませんでした`);
        }

        const deleteAt = new Date();
        deleteAt.setDate(deleteAt.getDate() + 3);

        // Supabaseへ保存
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

        if (insError) throw new Error(`Supabase Error: ${insError.message}`);

        // 45秒後にURL書き換え
        setTimeout(async () => {
            await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, 
                `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title](cracker) 完了！ (cracker)[/title]URL: ${deployUrl}\n※3日後に自動で消えます。[/info]`);
        }, 45000);

    } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        console.error("詳細エラー:", errMsg);
        await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title](shock) エラー発生[/title]理由: ${errMsg}[/info]`);
    }
});

// 3日経過したサービスを自動削除
async function cleanup() {
    const now = new Date().toISOString();
    const { data: targets } = await supabase.from('deploy_logs').select('*').lt('delete_at', now);
    if (targets && targets.length > 0) {
        for (const item of targets) {
            try {
                const acc = ACCOUNTS.find(a => a.ownerId === item.render_owner_id);
                if (acc) {
                    await axios.delete(`https://api.render.com/v1/services/${item.render_service_id}`, {
                        headers: { Authorization: `Bearer ${acc.key}` }
                    });
                }
                await cwApi.delete(`/rooms/${item.cw_room_id}/messages/${item.cw_message_id}`);
                await supabase.from('deploy_logs').delete().eq('id', item.id);
            } catch (e) {
                await supabase.from('deploy_logs').delete().eq('id', item.id);
            }
        }
    }
}
setInterval(cleanup, 1000 * 60 * 60);

app.listen(process.env.PORT || 3000, async () => {
    console.log(`Server started!`);
    await initAccounts();
});
