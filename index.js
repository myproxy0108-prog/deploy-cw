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

// ★追加: ユーザーが「URL入力待ち」の状態かを記録するメモリ
const pendingDeploys = {};

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

// Chatworkの返信タグなどを取り除き、純粋なテキストだけにする関数
function cleanMessage(text) {
    return text.replace(/\[rp aid=[0-9]+ to=[0-9\-]+\]/g, '')
               .replace(/\[To:[0-9]+\]/g, '')
               .trim();
}

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const event = req.body.webhook_event;
    if (!event || !event.body) return;

    const { account_id, body, room_id, message_id } = event;
    const user_name = event.from_account_id_name || "ユーザー";
    
    // タグを除去した純粋なメッセージ
    const bodyStr = cleanMessage(body);

    // ============================================
    // 1. /dl コマンド (一覧表示)
    // ============================================
    if (bodyStr === '/dl') {
        let listText = "";
        for (const [key, url] of Object.entries(REPO_CONFIG)) {
            const repoName = url.split('/').pop();
            listText += `■ ${key} \n  └ ${repoName}\n\n`;
        }
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]📝 作成可能なアプリ一覧[/title]以下の種類が指定できます。[hr]${listText}[hr]💡 使い方: 「/deploy tube」のように入力してください。[/info]`);
        return;
    }

    // ============================================
    // 2. /deploy コマンド (URL入力待ちへの移行)
    // ============================================
    if (bodyStr.startsWith('/deploy')) {
        const repoKey = bodyStr.split(' ')[1];
        const repoUrl = REPO_CONFIG[repoKey];

        if (!repoUrl) {
            await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]⚠️ エラー[/title]「${repoKey}」は登録されていません。\n※ /dl で一覧を確認できます。[/info]`);
            return;
        }
        if (ACCOUNTS.length === 0) {
            await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\nエラー: Renderアカウントが読み込めていません。`);
            return;
        }

        // 1日1回制限のチェック
        const today = new Date().toISOString().split('T')[0];
        const { data: logs } = await supabase.from('deploy_logs').select('*').eq('user_id', account_id.toString()).eq('deployed_at', today);
        if (logs && logs.length > 0) {
            await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title](stop) 制限[/title]今日はもう作っています！また明日！[/info]`);
            return;
        }

        // ★追加: URL待ち状態としてメモリに記録 (5分間有効)
        pendingDeploys[account_id] = {
            repoKey: repoKey,
            timestamp: Date.now()
        };

        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]🔗 URLの設定[/title]どのようなURLにしますか？\nこのメッセージに【英数字とハイフンのみ】で返信してください。\n\n（例: abide と打つと abide-xxxx.onrender.com になります）[/info]`);
        return;
    }

    // ============================================
    // 3. URL入力待ち状態のユーザーからの返信処理
    // ============================================
    if (pendingDeploys[account_id]) {
        const pending = pendingDeploys[account_id];
        
        // 5分経過していたらタイムアウトとしてキャンセル
        if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
            delete pendingDeploys[account_id];
            return; 
        }

        const customUrl = bodyStr;

        // ★文字のチェック (英数字とハイフンのみか)
        if (!/^[a-zA-Z0-9\-]+$/.test(customUrl)) {
            await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title]⚠️ エラー[/title]「${customUrl}」には使えない文字が含まれています。\n英数字とハイフンのみでもう一度返信してください。[/info]`);
            return;
        }

        // チェックを通過したので、待ち状態を解除
        delete pendingDeploys[account_id];

        const repoKey = pending.repoKey;
        const repoUrl = REPO_CONFIG[repoKey];

        const startRes = await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}-${message_id}]\n[info][title](dance) 準備中[/title]URLに「${customUrl}」を含めて構築を開始しました！\n少々お待ちを...[/info]`);
        const cw_msg_id = startRes.data.message_id;

        try {
            const acc = ACCOUNTS[Math.floor(Math.random() * ACCOUNTS.length)];

            // ★Renderのサービス名（＝URLのサブドメインになる）に指定された文字を組み込む
            // 重複エラーを防ぐため、後ろにランダムな4桁の数字を付ける (例: abide-9382)
            const randomCode = Math.floor(1000 + Math.random() * 9000);
            const serviceName = `${customUrl.substring(0, 20)}-${randomCode}`.toLowerCase();

            const createRes = await axios.post('https://api.render.com/v1/services', {
                name: serviceName, // ← ここがURLになります！
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
