import {createClient} from '@sanity/client'

export const client = createClient({
  projectId: '4qydhzw9',
  dataset: 'production',
  // eslint-disable-next-line no-undef
  token: process.env.SANITY_API_TOKEN || '', // Read from .env
  apiVersion: '2024-01-01',
  useCdn: false,
})

async function deletePost() {
  try {
    const result = await client.delete('fc5f870e-221f-4090-8e9b-9e84fdca54e5')
    console.log('Deleted document:', result)
  } catch (err) {
    console.error('Delete failed:', err.message)
  }
}

deletePost()
