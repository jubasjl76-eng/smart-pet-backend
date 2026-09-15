// Conventional commits. Trailers (Co-Authored-By, 🤖 Generated with…) are ignored
// by the body/footer rules below.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [0], // trailers + generated PR bodies run long
    'footer-max-line-length': [0],
  },
};
