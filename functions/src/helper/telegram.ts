import axios from 'axios';

export const sendTelegramMessage = async (message: string) => {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`
  const data = {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text: message,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'View on Mailerlite',
            url: 'https://app.mailerlite.com'
          }
        ]
      ]
    }
  };

  try {
    await axios.post(url, data)
    console.log('Telegram message sent')
    return
  } catch (error: any) {
    const errorMessage = error.response.data.description
    console.log(`Unable to send message to Telegram: ${errorMessage}`)
    throw new Error(errorMessage)
  }
};