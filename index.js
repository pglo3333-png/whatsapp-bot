const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrImage = require('qr-image');
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
const port = process.env.PORT || 3000;
let currentQr = '';
let isConnected = false;

// 1. 建立網頁 Preview 顯示 QR Code
app.get('/', (req, res) => {
    if (isConnected) {
        return res.send('<h1 style="color:green;font-family:sans-serif;text-align:center;margin-top:50px;">✅ WhatsApp 倉務機器人連線成功！</h1>');
    }
    if (!currentQr) {
        return res.send('<h1 style="font-family:sans-serif;text-align:center;margin-top:50px;">⏳ 正在產生 QR Code，請 5 秒後重新整理網頁...</h1>');
    }
    const code = qrImage.image(currentQr, { type: 'png' });
    res.type('png');
    code.pipe(res);
});

app.listen(port, () => console.log(`[Web Server] 網頁伺服器已啟動：Port ${port}`));

// 2. Google Sheets 連線初始化
async function getDoc() {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    return doc;
}

// 3. WhatsApp Client 初始化
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
});

client.on('qr', (qr) => {
    currentQr = qr;
    isConnected = false;
    console.log('--- 請掃描 QR CODE 登入 ---');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp 倉務機器人已準備就緒！');
    isConnected = true;
});

// 4. 訊息處理核心邏輯
client.on('message_create', async (msg) => {
    try {
        const body = msg.body.trim();
        if (!body) return;

        // A. 出貨扣數邏輯： 出貨 [Batch No] [Qty]
        if (body.startsWith('出貨')) {
            const parts = body.split(/\s+/);
            if (parts.length >= 3) {
                const targetBatch = parts[1];
                const deductQty = parseInt(parts[2], 10);

                if (isNaN(deductQty) || deductQty <= 0) {
                    return msg.reply('❌ 出貨數量必須為正整數！範例：出貨 7340 10');
                }

                const doc = await getDoc();
                const sheet = doc.sheetsByIndex[0];
                const rows = await sheet.getRows();

                let foundRow = null;
                for (const row of rows) {
                    if (String(row.get('Batch No.') || '').trim() === targetBatch) {
                        foundRow = row;
                        break;
                    }
                }

                if (!foundRow) {
                    return msg.reply(`❌ 找不到 Batch No. 為 [${targetBatch}] 的資料！`);
                }

                const currentQtyStr = foundRow.get('Qty') || '0';
                const currentQty = parseInt(String(currentQtyStr).replace(/[^0-9-]/g, ''), 10) || 0;

                if (currentQty < deductQty) {
                    return msg.reply(`⚠️ 庫存不足！Batch No. [${targetBatch}] 目前庫存為 ${currentQty}，無法扣減 ${deductQty}。`);
                }

                const newQty = currentQty - deductQty;
                foundRow.set('Qty', newQty);
                await foundRow.save();

                const partNo = foundRow.get('Parts No.') || 'N/A';
                const desc = foundRow.get('Parts Name EN') || 'N/A';
                return msg.reply(`✅ 【出貨成功】\n📦 料號: ${partNo}\n🏷 批號: ${targetBatch}\n📝 品名: ${desc}\n➖ 扣減數量: ${deductQty}\n📊 剩餘庫存: ${newQty}`);
            } else {
                return msg.reply('⚠️ 出貨格式不正確！格式為：出貨 [批號] [數量]\n例如：出貨 7340 10');
            }
        }

        // B. 模糊查詢邏輯 (Parts No. 模糊對應)
        if (body.length < 2) return;

        const query = body.toLowerCase();
        const doc = await getDoc();
        const sheet = doc.sheetsByIndex[0];
        const rows = await sheet.getRows();

        const matches = [];
        for (const row of rows) {
            const partNo = String(row.get('Parts No.') || '').trim();
            if (partNo.toLowerCase().includes(query)) {
                matches.push(row);
            }
        }

        if (matches.length === 0) {
            if (/^[a-zA-Z0-9\-_]+$/.test(body)) {
                return msg.reply(`❌ 找不到包含 [${body}] 的零件資料。`);
            }
            return;
        }

        if (matches.length === 1) {
            const row = matches[0];
            const partNo = row.get('Parts No.') || 'N/A';
            const batchNo = row.get('Batch No.') || 'N/A';
            const type = row.get('Type') || 'N/A';
            const desc = row.get('Parts Name EN') || 'N/A';
            const supplier = row.get('Supplier') || 'N/A';
            const wh = row.get('Warehouse') || '';
            const rack = row.get('Rack') || '';
            const bin = row.get('Bin') || '';
            const loc = [wh, rack, bin].filter(Boolean).join(' / ') || 'N/A';
            const qty = row.get('Qty') || '0';

            const replyMsg = `🔍 【零件資料查詢】\n━━━━━━━━━━━━━━\n📦 料號: ${partNo}\n🏷 批號: ${batchNo}\n📌 類別: ${type}\n📝 品名: ${desc}\n🏢 供應商: ${supplier}\n📍 存放架位: ${loc}\n📊 庫存數量: ${qty}`;
            return msg.reply(replyMsg);
        }

        if (matches.length > 1 && matches.length <= 10) {
            let listMsg = `🔍 找到 ${matches.length} 筆包含 [${body}] 的相關零件：\n━━━━━━━━━━━━━━\n`;
            matches.forEach((row, idx) => {
                const partNo = row.get('Parts No.') || 'N/A';
                const desc = row.get('Parts Name EN') || 'N/A';
                const qty = row.get('Qty') || '0';
                listMsg += `${idx + 1}. ${partNo} - ${desc} (庫存: ${qty})\n`;
            });
            listMsg += `\n請輸入更完整的料號來查看詳細資料。`;
            return msg.reply(listMsg);
        }

        if (matches.length > 10) {
            return msg.reply(`⚠️ 找到超過 10 筆符合 [${body}] 的零件，請輸入更精確的關鍵字！`);
        }

    } catch (err) {
        console.error('處理訊息時發生錯誤:', err);
    }
});

client.initialize();
