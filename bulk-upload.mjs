// run with `node bulk-upload.mjs`

import {createClient} from '@sanity/client'
import fs from 'fs'
import path from 'path'
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

const tagName = 'Oldschool' // Tag to assign to all images

async function uploadImages() {
  const folder = './trains' // folder with images
  const files = fs.readdirSync(folder)

  // Fetch Oldschool tag
  const tag = await client.fetch(`*[_type == "tag" && name == $name][0]{_id}`, {name: tagName})

  for (const file of files) {
    const filePath = path.join(folder, file)

    // Upload the image as an asset
    const asset = await client.assets.upload('image', fs.createReadStream(filePath), {
      filename: file,
    })

    // Create galleryImage document
    await client.create({
      _type: 'galleryImage',
      caption: path.parse(file).name,
      image: {
        _type: 'image',
        asset: {_type: 'reference', _ref: asset._id},
      },
      tags: [
        {
          _type: 'reference',
          _ref: tag._id,
        },
      ],
    })

    // eslint-disable-next-line no-undef
    console.log(`✅ Uploaded ${file} with ${tagName} tag`)
  }
}

// eslint-disable-next-line no-undef
uploadImages().catch(console.error)
