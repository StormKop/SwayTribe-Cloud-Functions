import axios from "axios"

export const addWaitlist = async (email: string) => {
  // Get Mailerlite API key from environment variables
  const mailerliteApiKey = process.env.MAILERLITE_API_KEY

  // Return error if Mailerlite API key is not found
  if (mailerliteApiKey === undefined) {
    throw new Error(`Mailerlite API key not found`)
  }

  // Add user to Mailerlite
  try {
    await axios.post(`https://connect.mailerlite.com/api/subscribers`, {
      email: email,
      fields: {
        sign_up_email_status: 'pending'
      }
    }, {
      headers: {
        'Authorization': `Bearer ${mailerliteApiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    })
  } catch (error: any) {
    // Return error from Mailerlite or if Mailerlite API key is invalid
    if(error instanceof Error) {
      throw new Error(`Unable to add user to Mailerlite: ${error.message}`)
    }
    const errorMessage = error.response.data.message
    console.log(`Unable to add user to Mailerlite: ${errorMessage}`);
    throw new Error(`Unable to add user to Mailerlite: ${errorMessage}`)
  }
}