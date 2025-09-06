import {defineField, defineType} from 'sanity'

export default defineType({
  name: 'galleryImage',
  type: 'document',
  title: 'Gallery Image',
  fields: [
    defineField({
      name: 'image',
      type: 'image',
      title: 'Image',
      options: {
        hotspot: true,
      },
    }),
    defineField({
      name: 'key',
      type: 'string',
      title: 'Key',
      description: 'Unique key for the image, auto-generated from the asset ID',
      readOnly: true,
    }),
    defineField({
      name: 'caption',
      type: 'string',
      title: 'Caption',
    }),
    defineField({
      name: 'photoCredit',
      type: 'string',
      title: 'Photo Credit',
      description: 'Photographer or source of the image',
    }),
    defineField({
      name: 'tags',
      title: 'Tags',
      type: 'array',
      of: [
        {
          type: 'reference',
          to: [{type: 'tag'}],
        },
      ],
    }),
  ],
  preview: {
    select: {
      media: 'image',
      key: 'key',
      caption: 'caption',
    },
    prepare(selection) {
      const {media, key, caption} = selection

      // Auto-generate key if not set
      let displayKey = key
      if (media && media.asset && !key) {
        displayKey = media.asset._ref.split('-')[1] // unique part of asset ID
      }

      return {
        title: caption || 'No caption',
        subtitle: displayKey,
        media,
      }
    },
  },
})
