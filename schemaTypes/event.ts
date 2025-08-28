import {defineArrayMember, defineField, defineType} from 'sanity'

export default defineType({
  name: 'event',
  title: 'Event',
  type: 'document',
  fields: [
    defineField({
      name: 'name',
      title: 'Name',
      type: 'string',
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      options: {
        source: 'name',
        maxLength: 96,
      },
    }),
    defineField({
      name: 'coverImage',
      title: 'Cover Image',
      type: 'image',
      options: {
        hotspot: true,
      },
    }),
    defineField({
      name: 'startDate',
      title: 'Start Date',
      type: 'datetime',
    }),
    defineField({
      name: 'endDate',
      title: 'End Date',
      type: 'datetime',
    }),
    defineField({
      name: 'address',
      title: 'Address',
      type: 'string',
    }),
    defineField({
      name: 'mapLink',
      title: 'Map Link',
      type: 'url',
      validation: (Rule) =>
        Rule.uri({
          scheme: ['http', 'https'],
        }),
    }),
    defineField({
      name: 'description',
      title: 'Desription',
      type: 'array',
      of: [
        {
          title: 'Block',
          type: 'block',
          styles: [{title: 'Normal', value: 'normal'}],
          lists: [],
        },
      ],
    }),
    defineField({
      name: 'eventPartners',
      title: 'Foundation Partners',
      type: 'array',
      of: [
        defineArrayMember({
          type: 'reference',
          to: [{type: 'partner'}],
        }),
      ],
      validation: (Rule) => Rule.max(8),
    }),
    defineField({
      name: 'featuredGalleryImages',
      title: 'Featured Gallery Images',
      type: 'array',
      of: [
        defineArrayMember({
          type: 'reference',
          to: [{type: 'galleryImage'}],
        }),
      ],
    }),
  ],
})
