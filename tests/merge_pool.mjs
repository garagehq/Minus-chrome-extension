// Top up the harvested pool (tech/news-skewed) with a curated supplement of
// well-known domains across categories aggregators miss, to reach >=1000 distinct
// registrable domains for the soak. Merges + dedupes into tests/site_pool_1k.json.
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const HERE = dirname(fileURLToPath(import.meta.url));
const POOL = join(HERE, "site_pool_1k.json");

const EXTRA = `
amazon.com ebay.com walmart.com target.com bestbuy.com etsy.com aliexpress.com wayfair.com
homedepot.com lowes.com costco.com ikea.com wish.com newegg.com chewy.com overstock.com
macys.com nordstrom.com kohls.com zappos.com asos.com shein.com temu.com nike.com adidas.com
sephora.com ulta.com gap.com hm.com uniqlo.com zara.com lululemon.com underarmour.com
netflix.com hulu.com disneyplus.com hbomax.com max.com peacocktv.com paramountplus.com
primevideo.com crunchyroll.com twitch.tv vimeo.com dailymotion.com spotify.com pandora.com
soundcloud.com deezer.com tidal.com last.fm bandcamp.com audible.com
chase.com bankofamerica.com wellsfargo.com citi.com capitalone.com usbank.com pnc.com
americanexpress.com discover.com paypal.com venmo.com stripe.com squareup.com wise.com
fidelity.com vanguard.com schwab.com robinhood.com coinbase.com binance.com kraken.com
etrade.com morganstanley.com goldmansachs.com nerdwallet.com creditkarma.com mint.com
expedia.com booking.com airbnb.com vrbo.com kayak.com priceline.com tripadvisor.com
hotels.com marriott.com hilton.com delta.com united.com aa.com southwest.com jetblue.com
lufthansa.com emirates.com britishairways.com ryanair.com skyscanner.com hopper.com
uber.com lyft.com doordash.com ubereats.com grubhub.com instacart.com opentable.com yelp.com
allrecipes.com foodnetwork.com epicurious.com seriouseats.com bonappetit.com delish.com
espn.com nba.com nfl.com mlb.com nhl.com fifa.com uefa.com skysports.com bleacherreport.com
cbssports.com foxsports.com goal.com formula1.com nascar.com pgatour.com wwe.com
webmd.com mayoclinic.com healthline.com clevelandclinic.com nih.gov cdc.gov who.int
medlineplus.gov drugs.com goodrx.com zocdoc.com psychologytoday.com everydayhealth.com
coursera.org edx.org udemy.com khanacademy.org duolingo.com brilliant.org skillshare.com
mit.edu stanford.edu harvard.edu berkeley.edu ox.ac.uk cam.ac.uk yale.edu princeton.edu
quizlet.com chegg.com scholar.google.com jstor.org researchgate.net academia.edu
wikipedia.org wiktionary.org britannica.com dictionary.com merriam-webster.com thesaurus.com
usa.gov whitehouse.gov irs.gov usps.com fbi.gov nasa.gov noaa.gov weather.gov ssa.gov
gov.uk canada.ca australia.gov.au europa.eu un.org worldbank.org imf.org
facebook.com instagram.com twitter.com x.com linkedin.com pinterest.com tiktok.com
snapchat.com reddit.com tumblr.com quora.com discord.com telegram.org whatsapp.com
mastodon.social threads.net nextdoor.com meetup.com
google.com bing.com duckduckgo.com yahoo.com yandex.com baidu.com ecosia.org brave.com
gmail.com outlook.com proton.me icloud.com zoho.com fastmail.com
github.com gitlab.com bitbucket.org stackoverflow.com stackexchange.com npmjs.com pypi.org
dev.to hashnode.com codepen.io replit.com vercel.com netlify.com heroku.com digitalocean.com
cloudflare.com aws.amazon.com azure.microsoft.com cloud.google.com docker.com kubernetes.io
figma.com canva.com notion.so slack.com zoom.us trello.com asana.com monday.com atlassian.com
dropbox.com box.com wetransfer.com grammarly.com
nytimes.com washingtonpost.com wsj.com theguardian.com bbc.com reuters.com apnews.com
bloomberg.com forbes.com cnbc.com ft.com economist.com theatlantic.com newyorker.com
time.com npr.org pbs.org aljazeera.com dw.com france24.com lemonde.fr spiegel.de
elpais.com corriere.it asahi.com scmp.com thehindu.com timesofindia.indiatimes.com
usatoday.com latimes.com chicagotribune.com nypost.com politico.com axios.com vox.com
buzzfeed.com huffpost.com businessinsider.com vice.com slate.com salon.com thedailybeast.com
theverge.com wired.com arstechnica.com techcrunch.com engadget.com gizmodo.com cnet.com
zdnet.com tomshardware.com anandtech.com pcmag.com macrumors.com 9to5mac.com androidcentral.com
imdb.com rottentomatoes.com metacritic.com letterboxd.com goodreads.com
ign.com gamespot.com polygon.com kotaku.com pcgamer.com steampowered.com epicgames.com
roblox.com minecraft.net ea.com ubisoft.com rockstargames.com nintendo.com playstation.com
xbox.com gog.com humblebundle.com
medium.com substack.com wordpress.com blogger.com wix.com squarespace.com weebly.com
craigslist.org indeed.com glassdoor.com monster.com ziprecruiter.com linkedin.com upwork.com
fiverr.com behance.net dribbble.com deviantart.com artstation.com unsplash.com pexels.com
shutterstock.com gettyimages.com flickr.com 500px.com
zillow.com realtor.com redfin.com trulia.com apartments.com
carmax.com carvana.com autotrader.com cars.com kbb.com edmunds.com
homedepot.com wikihow.com instructables.com thespruce.com housebeautiful.com
nationalgeographic.com smithsonianmag.com history.com sciencedaily.com livescience.com
space.com scientificamerican.com nature.com sciencemag.org newscientist.com
mirror.co.uk thesun.co.uk telegraph.co.uk independent.co.uk dailymail.co.uk metro.co.uk
standard.co.uk express.co.uk thetimes.co.uk sky.com itv.com channel4.com
bild.de zeit.de faz.net welt.de sueddeutsche.de focus.de stern.de tagesschau.de heise.de
liberation.fr lefigaro.fr lemonde.fr leparisien.fr 20minutes.fr ouest-france.fr
repubblica.it lastampa.it ilsole24ore.com gazzetta.it ansa.it
elmundo.es abc.es lavanguardia.com marca.com as.com sport.es
globo.com uol.com.br folha.uol.com.br terra.com.br estadao.com.br
clarin.com lanacion.com.ar eluniversal.com.mx milenio.com
nhk.or.jp yomiuri.co.jp mainichi.jp nikkei.com japantimes.co.jp
chosun.com joins.com donga.com koreaherald.com
straitstimes.com channelnewsasia.com bangkokpost.com jakartapost.com
smh.com.au theage.com.au news.com.au abc.net.au theaustralian.com.au
theglobeandmail.com nationalpost.com cbc.ca ctvnews.ca thestar.com
ndtv.com hindustantimes.com indianexpress.com livemint.com thehindu.com deccanherald.com
dawn.com aljazeera.net haaretz.com jpost.com timesofisrael.com gulfnews.com
moscowtimes.com rt.com tass.com kyivindependent.com
xinhuanet.com chinadaily.com.cn globaltimes.cn caixinglobal.com
kompas.com detik.com rappler.com inquirer.net vnexpress.net
mnb.hu index.hu onet.pl wp.pl gazeta.pl interia.pl
nu.nl telegraaf.nl volkskrant.nl nrc.nl
aftonbladet.se dn.se svd.se vg.no nrk.no dr.dk politiken.dk
hs.fi yle.fi kathimerini.gr protothema.gr
sabah.com.tr hurriyet.com.tr milliyet.com.tr
etsy.com bandcamp.com discogs.com genius.com allmusic.com
goodreads.com librarything.com bookdepository.com abebooks.com
myfitnesspal.com strava.com fitbit.com garmin.com peloton.com
notonthehighstreet.com farfetch.com net-a-porter.com ssense.com endclothing.com
patagonia.com rei.com backcountry.com moosejaw.com
petco.com petsmart.com
homedepot.ca canadiantire.ca argos.co.uk currys.co.uk johnlewis.com
flipkart.com myntra.com snapdeal.com rakuten.co.jp mercadolibre.com
booking.com agoda.com trip.com hostelworld.com couchsurfing.com rome2rio.com
weather.com accuweather.com wunderground.com windy.com
speedtest.net fast.com downdetector.com whatismyipaddress.com
archive.org gutenberg.org openlibrary.org arxiv.org ssrn.com
producthunt.com indiehackers.com angel.co crunchbase.com pitchbook.com
zapier.com airtable.com clickup.com basecamp.com todoist.com evernote.com
mailchimp.com hubspot.com salesforce.com zendesk.com intercom.com
stackoverflow.blog smashingmagazine.com css-tricks.com sitepoint.com freecodecamp.org
w3schools.com geeksforgeeks.org tutorialspoint.com codecademy.com leetcode.com hackerrank.com
`.trim().split(/\s+/).filter(Boolean);

// Common multi-label public suffixes (eTLD+1 needs the 3rd label for these).
const TWO_LABEL_TLD = new Set([
  "co.uk","org.uk","ac.uk","gov.uk","me.uk","ltd.uk","plc.uk",
  "co.jp","or.jp","ne.jp","ac.jp","go.jp","com.au","net.au","org.au","gov.au","edu.au",
  "co.nz","org.nz","co.in","net.in","org.in","gen.in","firm.in","ind.in",
  "com.br","net.br","org.br","gov.br","co.za","org.za","com.mx","org.mx",
  "co.kr","or.kr","com.tr","gov.tr","edu.tr","com.sg","com.hk","com.tw","com.cn","net.cn","org.cn","gov.cn",
  "com.ar","net.ar","org.ar","gob.ar","com.ua","com.co","com.ph","com.my","com.ng","com.pk","com.sa","com.eg",
  "co.id","co.il","org.il","co.th","com.vn","com.pe","com.ec","com.uy","com.do","com.gt","com.ve",
]);
// A domain that IS a public suffix (e.g. "com.ar", "co.uk") is not a real site.
const isPublicSuffix = (d) => TWO_LABEL_TLD.has(d) || /^(com|net|org|co|gov|edu|ac|gob|go|or|ne)\.[a-z]{2,3}$/.test(d) || d.split(".").length < 2;
function reg(h) { h = h.toLowerCase().replace(/^www\./, ""); const p = h.split("."); if (p.length <= 2) return h; const l2 = p.slice(-2).join("."); return TWO_LABEL_TLD.has(l2) ? p.slice(-3).join(".") : l2; }

let pool = JSON.parse(readFileSync(POOL, "utf8"));
// clean any junk bare-public-suffix entries that a prior reducer produced
const before = pool.length;
pool = pool.filter((s) => { try { return !isPublicSuffix(reg(new URL(s.url).hostname)); } catch { return false; } });
const dropped = before - pool.length;
const seen = new Set(pool.map((s) => reg(new URL(s.url).hostname)));
let added = 0;
for (const d of EXTRA) { const r = reg(d); if (!isPublicSuffix(r) && !seen.has(r)) { seen.add(r); pool.push({ name: r, url: `https://${r}/` }); added++; } }
writeFileSync(POOL, JSON.stringify(pool, null, 0));
console.log(`cleaned ${dropped} junk public-suffix entries, +${added} new, pool now ${pool.length} distinct domains`);
