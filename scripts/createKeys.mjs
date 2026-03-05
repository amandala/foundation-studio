// scripts/updateGalleryKeys.ts
import {createClient} from '@sanity/client'
import dotenv from 'dotenv'

dotenv.config()

export const client = createClient({
  projectId: '4qydhzw9',
  dataset: 'production',
  // eslint-disable-next-line no-undef
  token: process.env.SANITY_API_TOKEN || '', // Read from .env
  apiVersion: '2024-01-01',
  useCdn: false,
})

async function updateGalleryImages() {
  try {
    const images = await client.fetch(`*[_type == "galleryImage"]{
      _id,
      key,
      image{asset->{_ref}},
      caption
    }`)

    for (const image of images) {
      if (image.image?.asset?._ref) {
        const assetId = image.image.asset._ref.split('-')[1]

        await client
          .patch(image._id)
          .set({key: assetId, caption: ''}) // set key and clear caption
          .commit()

        console.log(`✅ Updated ${image._id} with key: ${assetId} and cleared caption`)
      }
    }

    console.log('All gallery images processed.')
  } catch (err) {
    console.error('Error updating gallery images:', err)
  } finally {
    process.exit()
  }
}

updateGalleryImages()
