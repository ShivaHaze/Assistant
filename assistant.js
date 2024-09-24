const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const https = require('https');
const FormData = require('form-data');  // Add this to require FormData
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { google } = require('googleapis');

// Load your Google Calendar API credentials
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const TOKEN_PATH = 'token.json';
const CREDENTIALS_PATH = 'credentials.json';

// Telegram bot setup
const allowedUserId = 379641559;
const apiKey = '';
const telegramToken = '';
const bot = new TelegramBot(telegramToken, { polling: true });

// Pricing for GPT and TTS
const pricingGPT4o = { prompt: 0.005, completion: 0.015 };
const pricingTTS = { perCharacter: 0.000015 };

// Respond to /start command and show user their Telegram ID
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;  // This is your Telegram ID
    bot.sendMessage(chatId, `Hello! Your Telegram ID is ${chatId}`);
});

// Respond to /ask <question>
bot.onText(/\/ask (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId !== allowedUserId) return;  // Ignore if not from you
    const question = match[1];
    const response = await getChatGPTResponse(question);
    bot.sendMessage(chatId, response);
});

// Respond to /tts <text>
bot.onText(/\/tts (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId !== allowedUserId) return;  // Ignore if not from you
    const text = match[1];
    await generateSpeechFromText(text);
    bot.sendAudio(chatId, 'output.mp3');  // Send the generated MP3 file
});

// Respond to /pdf <url>
bot.onText(/\/pdf (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId !== allowedUserId) return;  // Ignore if not from you
    const pdfUrl = match[1];
    const outputFilename = 'downloaded_pdf.pdf';

    try {
        // Download the PDF and wait until the download is complete
        await downloadPDF(pdfUrl, outputFilename);

        // Extract text and summarize
        const promptText = 'Summarize this PDF in German:';
        await summarizePDF(outputFilename, promptText, chatId);
    } catch (error) {
        console.error('Error handling PDF command:', error);
        bot.sendMessage(chatId, 'Sorry, there was an error downloading or processing the PDF.');
    }
});

// Respond to voice messages for either answering questions or creating calendar events
bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    if (chatId !== allowedUserId) return;
    const fileId = msg.voice.file_id;

    try {
        // Get file path from Telegram
        const file = await bot.getFile(fileId);
        const filePath = file.file_path;

        // Download the voice message file
        const url = `https://api.telegram.org/file/bot${telegramToken}/${filePath}`;
        const outputFilename = 'voice_message.ogg';
        await downloadFile(url, outputFilename);

        // Transcribe the audio to text using Whisper
        const transcribedText = await transcribeAudioToText(outputFilename);

        // Ask ChatGPT to classify the intent: Is it a question or an appointment request?
        const intentClassificationPrompt = `
        The following is a voice transcription: "${transcribedText}". 
        Is this transcription asking a general question or requesting to schedule an appointment? 
        Reply with either "question" or "appointment".
        `;
        const intentResponse = await getChatGPTResponse(intentClassificationPrompt);

        if (intentResponse.toLowerCase().includes('appointment')) {
            // If it's an appointment request, extract appointment details
            const chatGPTResponse = await getChatGPTResponse(transcribedText);
            const { title, date, time, duration } = extractAppointmentDetails(chatGPTResponse);

            // Insert the appointment into Google Calendar
            const calendarResponse = await insertGoogleCalendarEvent({ title, date, time, duration });

            // Notify the user
            bot.sendMessage(chatId, `Appointment created: ${calendarResponse.htmlLink}`);
        } else {
            // If it's a general question, process it as usual
            const chatGPTResponse = await getChatGPTResponse(transcribedText);
            bot.sendMessage(chatId, `ChatGPT's response: ${chatGPTResponse}`);
        }
    } catch (error) {
        console.error('Error processing voice message:', error);
        bot.sendMessage(chatId, 'Sorry, I could not process your voice message.');
    }
});

// Function to extract appointment details using ChatGPT response
function extractAppointmentDetails(chatGPTResponse) {
    // Example extraction logic, depends on how GPT-4 structures the output
    const lines = chatGPTResponse.split('\n');
    const title = lines.find(line => line.includes('Title:')).split('Title:')[1].trim();
    const date = lines.find(line => line.includes('Date:')).split('Date:')[1].trim();
    const time = lines.find(line => line.includes('Time:')).split('Time:')[1].trim();
    const duration = lines.find(line => line.includes('Duration:')).split('Duration:')[1].trim();
    
    return { title, date, time, duration };
}

// Function to insert an event into Google Calendar
async function insertGoogleCalendarEvent(eventDetails) {
    const { title, date, time, duration } = eventDetails;

    const auth = await authenticateGoogleCalendar();
    const calendar = google.calendar({ version: 'v3', auth });

    const startDateTime = new Date(`${date}T${time}:00`);
    const endDateTime = new Date(startDateTime.getTime() + duration * 60000);

    const event = {
        summary: title,
        start: { dateTime: startDateTime.toISOString(), timeZone: 'Europe/Berlin' },
        end: { dateTime: endDateTime.toISOString(), timeZone: 'Europe/Berlin' },
    };

    const response = await calendar.events.insert({
        calendarId: 'primary',
        resource: event,
    });

    return response.data;
}

// Google Calendar Authentication
async function authenticateGoogleCalendar() {
    const { client_secret, client_id, redirect_uris } = JSON.parse(fs.readFileSync(CREDENTIALS_PATH)).installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (fs.existsSync(TOKEN_PATH)) {
        const token = fs.readFileSync(TOKEN_PATH);
        oAuth2Client.setCredentials(JSON.parse(token));
    } else {
        throw new Error('No Google Calendar token found. Please authenticate manually.');
    }

    return oAuth2Client;
}

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
    return new Promise((resolve, reject) => {
        const filePath = path.resolve(__dirname, filename);
        const file = fs.createWriteStream(filePath);

        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);  // Resolve the promise when the download finishes
                console.log('Download completed:', filePath);
            });
        }).on('error', (error) => {
            fs.unlink(filePath, () => {
                console.error('Error downloading PDF:', error.message);
                reject(error);  // Reject the promise if an error occurs
            });
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

// Function to summarize a PDF using ChatGPT and send the response to Telegram
async function summarizePDF(pdfPath, prompt, chatId) {
    try {
        const pdfText = await extractTextFromPDF(pdfPath);

        if (pdfText) {
            const summary = await getChatGPTResponseWithPDFText(prompt, pdfText);
            console.log('Summary:', summary);

            // Send the summary back to the user via Telegram
            await bot.sendMessage(chatId, `Here is the summary of the PDF:\n\n${summary}`);
        } else {
            await bot.sendMessage(chatId, 'Sorry, I could not extract text from the PDF.');
        }
    } catch (error) {
        console.error('Error summarizing PDF:', error);
        await bot.sendMessage(chatId, 'Sorry, there was an error summarizing the PDF.');
    }
}
