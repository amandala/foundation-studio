export default {
  name: 'galleryImage',
  type: 'document',
  title: 'Gallery Image',
  __experimental_actions: ['create', 'update', 'delete', 'publish'], // allow all actions
  fields: [
    {
      name: 'image',
      type: 'image',
      title: 'Image',
      options: {
        hotspot: true,
      },
    },
    {
      name: 'caption',
      type: 'string',
      title: 'Caption',
    },
    {
      name: 'photoCredit',
      type: 'string',
      title: 'Photo Credit',
      description: 'Photographer or source of the image',
    },
    {
      name: 'tags',
      title: 'Tags',
      type: 'array',
      of: [
        {
          type: 'reference',
          to: [{type: 'tag'}],
        },
      ],
    },
  ],
}
