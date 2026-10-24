// Public settings for the TruckDocs app (development project).
// The publishable key is designed to be public: every request is still limited by the
// database's Row Level Security rules. The secret/service key must NEVER appear in this app.
window.TD_CONFIG = {
  supabaseUrl: 'https://uirbbtlrejbyjknakyin.supabase.co',
  supabaseKey: 'sb_publishable_o5P2Hy9lbywcitUPXpMxXA_-zYc1wQ4',
  environment: 'development',
  languages: ['en', 'en-pa', 'en-hi', 'en-fr'],   // add a language: add its file in i18n/ and list it here
};
