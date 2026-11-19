// Hand-picked fixes for names OCR can't read reliably -- usually because
// part of the name is in a script it mangles. Each entry maps the part OCR
// does get right to the member's exact Growth Rate name. A reading counts
// when it is the alias or ends with it, since the unreadable part usually
// comes first ("4Eminju" for 박민주minju).
//
// To add one: 'what OCR reads': 'Exact Growth Rate name'.
const NAME_ALIASES = {
  minju: '박민주minju',
};

module.exports = { NAME_ALIASES };
