const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const https = require('https');
const FormData = require('form-data');  // Add this to require FormData
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const xpath = require('xpath');
const { DOMParser } = require('xmldom');

// Your OpenAI API key
const apiKey = '';

// Telegram bot token
const telegramToken = '';

// Create a bot that uses polling to fetch new updates
const bot = new TelegramBot(telegramToken, { polling: true });

// Pricing for GPT and TTS
const pricingGPT4o = { prompt: 0.005, completion: 0.015 };
const pricingTTS = { perCharacter: 0.000015 };

// Responds to the "/start" command
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "Welcome! Send me a command:\n- /ask <question>\n- /tts <text>\n- /pdf <url>\n- Send me a voice memo, and I'll convert it to text and give an AI-generated response.");
});

// Respond to /ask <question>
bot.onText(/\/ask (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const question = match[1];

    const response = await getChatGPTResponse(question);
    bot.sendMessage(chatId, response);
});

// Respond to /tts <text>
bot.onText(/\/tts (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const text = match[1];

    await generateSpeechFromText(text);
    bot.sendAudio(chatId, 'output.mp3'); // Send the generated MP3 file
});

// Respond to /pdf <url>
bot.onText(/\/pdf (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const pdfUrl = match[1];
    const outputFilename = 'downloaded_pdf.pdf';

    // Download the PDF
    downloadPDF(pdfUrl, outputFilename);

    // Extract text and summarize
    const promptText = 'Summarize this PDF in german:';
    await summarizePDF(outputFilename, promptText, chatId);
});

// Respond to voice messages
bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    const fileId = msg.voice.file_id;

    try {
        // Get file path from Telegram
        const file = await bot.getFile(fileId);
        const filePath = file.file_path;

        // Download the voice message file from Telegram servers
        const url = `https://api.telegram.org/file/bot${telegramToken}/${filePath}`;
        const outputFilename = 'voice_message.ogg';  // Save the downloaded voice message as .ogg file

        // Download the voice file
        await downloadFile(url, outputFilename);

        // Convert the audio file to text using OpenAI's Whisper API
        const transcribedText = await transcribeAudioToText(outputFilename);

        // Send the transcribed text to ChatGPT
        const chatGPTResponse = await getChatGPTResponse(transcribedText);

        // Send ChatGPT's response back to the user
        bot.sendMessage(chatId, `I understood: ${transcribedText}\n\nChatGPT's response: ${chatGPTResponse}`);
    } catch (error) {
        console.error('Error processing voice message:', error);
        bot.sendMessage(chatId, 'Sorry, I could not process your voice message.');
    }
});

// Function to download a file from a given URL
function downloadFile(url, filename) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filename);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
                console.log('Download completed:', filename);
            });
        }).on('error', (error) => {
            fs.unlink(filename, () => {
                console.error('Error downloading file:', error.message);
                reject(error);
            });
        });
    });
}

// Function to transcribe audio to text using OpenAI's Whisper API
async function transcribeAudioToText(audioFilePath) {
    const apiUrl = 'https://api.openai.com/v1/audio/transcriptions';
    const formData = new FormData();

    // Append the audio file to the form data
    formData.append('file', fs.createReadStream(audioFilePath));
    formData.append('model', 'whisper-1');

    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        ...formData.getHeaders(),  // Attach the form-data headers
    };

    try {
        const response = await axios.post(apiUrl, formData, { headers });
        const transcription = response.data.text;
        return transcription;
    } catch (error) {
        console.error('Error with Whisper API:', error);
        throw error;
    }
}

// Function to get ChatGPT response
async function getChatGPTResponse(prompt) {
    const apiUrl = 'https://api.openai.com/v1/chat/completions';
    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
    };
    const data = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
    };

    try {
        const response = await axios.post(apiUrl, data, { headers });
        const reply = response.data.choices[0].message.content;
        return reply;
    } catch (error) {
        console.error('Error with ChatGPT API:', error);
        return 'Error fetching response from ChatGPT.';
    }
}

// Function to generate speech from text
async function generateSpeechFromText(text) {
    const apiUrl = 'https://api.openai.com/v1/audio/speech';
    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
    };
    const data = {
        input: text,
        model: 'tts-1',
        voice: 'alloy'
    };

    try {
        const response = await axios.post(apiUrl, data, { headers, responseType: 'arraybuffer' });
        const mp3Data = response.data;
        const filePath = 'output.mp3';
        fs.writeFileSync(filePath, mp3Data);
        console.log(`MP3 file saved as ${filePath}`);
    } catch (error) {
        console.error('Error with TTS API:', error);
    }
}

// Function to download a PDF
function downloadPDF(url, filename) {
    const filePath = path.resolve(__dirname, filename);
    const file = fs.createWriteStream(filePath);

    https.get(url, (response) => {
        response.pipe(file);
        file.on('finish', () => {
            file.close();
            console.log('Download completed:', filePath);
        });
    }).on('error', (error) => {
        fs.unlink(filePath, () => {
            console.error('Error downloading PDF:', error.message);
        });
    });
}

// Function to extract text from a PDF
async function extractTextFromPDF(pdfPath) {
    const dataBuffer = fs.readFileSync(pdfPath);
    try {
        const data = await pdfParse(dataBuffer);

        return data.text;
    } catch (error) {
        console.error('Error extracting text from PDF:', error.message);
    }
}

// Function to send extracted text to ChatGPT for a summary
async function getChatGPTResponseWithPDFText(prompt, pdfText) {
    const apiUrl = 'https://api.openai.com/v1/chat/completions';

    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
    };

    const data = {
        model: 'gpt-4o',
        messages: [
            { role: 'user', content: `${prompt}\n\nHere is the extracted text from the PDF:\n\n${pdfText}` }
        ],
    };

    try {
        const response = await axios.post(apiUrl, data, { headers });
        const reply = response.data.choices[0].message.content;

        // Log usage and cost (optional)
        const usage = response.data.usage;
        const promptTokens = usage.prompt_tokens;
        const completionTokens = usage.completion_tokens;
        const totalTokens = usage.total_tokens;

        const promptCost = (promptTokens / 1000) * pricingGPT4o.prompt;
        const completionCost = (completionTokens / 1000) * pricingGPT4o.completion;
        const totalCost = promptCost + completionCost;

        console.log(`Tokens used (Prompt: ${promptTokens}, Completion: ${completionTokens}, Total: ${totalTokens})`);
        console.log(`Estimated cost: $${totalCost.toFixed(5)}`);

        return reply;
    } catch (error) {
        console.error('Error with ChatGPT API:', error);
        return 'Error summarizing the PDF with ChatGPT.';
    }
}


// Function to summarize a PDF using ChatGPT
async function summarizePDF(pdfPath, prompt, chatId) {
    try {
        const pdfText = await extractTextFromPDF(pdfPath);

        if (pdfText) {
            let reply = await getChatGPTResponseWithPDFText(prompt, pdfText);
            bot.sendMessage(chatId, reply);
        }
    } catch (error) {
        console.error('Error summarizing PDF:', error);
    }
}
