/** Small synthetic emails shared by mapper and real-editor regression tests. */
export const VML_COMPONENT = `<html><body><table><tr><td class="mktoText" id="bodyText" mktoName="Body">
<!--[if mso]><v:roundrect style="width:160px;height:40px" fillcolor="#336699">Read more</v:roundrect><![endif]-->
</td></tr></table></body></html>`;

export const STYLE_SURVIVAL = '<html><body><div style="color:rgb(0 0 0);padding:12px">Body copy</div></body></html>';

export const DARK_CONTRAST = '<html><body><div style="background-color:#ffffff">' +
  '<p style="color:#555555;font-size:14px">Body copy</p></div></body></html>';

export const MOBILE_CONTRAST = `<html><head><style>
.card{background-color:#111111}
.copy{color:#ffffff;font-size:14px}
@media only screen and (max-width:600px){ .card{background-color:#ffffff} }
</style></head><body><div class="card"><p class="copy">Body copy</p></div></body></html>`;

export const DEPRECATED_TARGETING = '<html><head><style>_:-webkit-full-screen,.body .copy{color:#333333}</style></head>' +
  '<body class="body"><p class="copy">Body copy</p></body></html>';
