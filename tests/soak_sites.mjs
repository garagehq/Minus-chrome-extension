// ~230 real sites for the breadth soak. `v` = video (autoplay/ad-break path),
// `z` = expected-clean (overlays here are almost certainly false positives).
// Everything else is a general ad-supported page — any overlay is reviewed via
// its captured crop (real-ad vs FP). Many will fail to load headless
// (paywalls / bot walls); the soak try/catches those and moves on.
const S = (url, opts = {}) => ({ name: new URL(url).hostname.replace(/^www\./, "").split(".").slice(0, 2).join("."), url, ...opts });

export const SOAK_SITES = [
  // ---- national news ----
  S("https://www.cnn.com/"), S("https://www.foxnews.com/"), S("https://www.nbcnews.com/"),
  S("https://www.cbsnews.com/"), S("https://abcnews.go.com/"), S("https://www.usatoday.com/"),
  S("https://www.washingtonpost.com/"), S("https://www.theguardian.com/us"), S("https://www.reuters.com/"),
  S("https://apnews.com/hub/technology"), S("https://www.bbc.com/news"), S("https://www.npr.org/"),
  S("https://www.politico.com/"), S("https://thehill.com/"), S("https://www.axios.com/"),
  S("https://www.vox.com/"), S("https://www.huffpost.com/"), S("https://www.newsweek.com/"),
  S("https://time.com/"), S("https://nypost.com/"), S("https://www.dailymail.co.uk/ushome/index.html"),
  S("https://www.mirror.co.uk/"), S("https://www.thesun.co.uk/"), S("https://www.independent.co.uk/us"),
  S("https://metro.co.uk/"), S("https://www.latimes.com/"), S("https://www.chicagotribune.com/"),
  S("https://www.sfgate.com/"), S("https://www.nj.com/"), S("https://slate.com/"),
  // ---- tech ----
  S("https://www.theverge.com/"), S("https://www.engadget.com/"), S("https://techcrunch.com/"),
  S("https://arstechnica.com/"), S("https://www.wired.com/"), S("https://gizmodo.com/"),
  S("https://mashable.com/"), S("https://www.cnet.com/"), S("https://www.zdnet.com/"),
  S("https://www.tomshardware.com/"), S("https://www.pcmag.com/"), S("https://www.digitaltrends.com/"),
  S("https://www.androidauthority.com/"), S("https://9to5mac.com/"), S("https://www.macrumors.com/"),
  S("https://www.xda-developers.com/"), S("https://www.techradar.com/"), S("https://www.howtogeek.com/"),
  S("https://lifehacker.com/"), S("https://slashdot.org/"), S("https://www.tomsguide.com/"),
  // ---- entertainment / celebrity (editorial-photo FP zone) ----
  S("https://www.usmagazine.com/"), S("https://people.com/"), S("https://www.tmz.com/"),
  S("https://www.eonline.com/"), S("https://ew.com/"), S("https://variety.com/"),
  S("https://www.hollywoodreporter.com/"), S("https://deadline.com/"), S("https://www.buzzfeed.com/"),
  S("https://www.vulture.com/"), S("https://www.rollingstone.com/"), S("https://www.billboard.com/"),
  S("https://pitchfork.com/"), S("https://www.complex.com/"), S("https://www.avclub.com/"),
  S("https://screenrant.com/"), S("https://collider.com/"), S("https://www.cbr.com/"),
  S("https://www.ign.com/"), S("https://www.gamespot.com/"), S("https://www.polygon.com/"),
  S("https://kotaku.com/"), S("https://comicbook.com/"), S("https://www.thewrap.com/"),
  S("https://www.eurogamer.net/"), S("https://www.pcgamer.com/"), S("https://www.giantbomb.com/"),
  // ---- sports ----
  S("https://www.espn.com/"), S("https://www.cbssports.com/"), S("https://bleacherreport.com/"),
  S("https://www.si.com/"), S("https://www.foxsports.com/"), S("https://sports.yahoo.com/"),
  S("https://www.sbnation.com/"), S("https://www.goal.com/en-us"), S("https://www.skysports.com/"),
  S("https://talksport.com/"), S("https://247sports.com/"), S("https://www.nbcsports.com/"),
  S("https://www.mlb.com/"), S("https://www.nba.com/"), S("https://www.nfl.com/"),
  // ---- shopping (product images must NOT flag) ----
  S("https://www.amazon.com/s?k=headphones"), S("https://www.ebay.com/sch/i.html?_nkw=laptop"),
  S("https://www.walmart.com/search?q=tv"), S("https://www.target.com/s?searchTerm=shoes"),
  S("https://www.bestbuy.com/site/searchpage.jsp?st=monitor"), S("https://www.etsy.com/search?q=necklace"),
  S("https://www.aliexpress.com/wholesale?SearchText=phone+case"), S("https://www.wayfair.com/keyword.php?keyword=sofa"),
  S("https://www.homedepot.com/s/drill"), S("https://www.lowes.com/search?searchTerm=paint"),
  S("https://www.macys.com/shop/featured/dress"), S("https://www.newegg.com/p/pl?d=ssd"),
  S("https://www.nike.com/w?q=sneakers"), S("https://www.ikea.com/us/en/search/?q=desk"),
  // ---- recipes / food ----
  S("https://www.allrecipes.com/"), S("https://www.foodnetwork.com/"), S("https://www.delish.com/"),
  S("https://tasty.co/"), S("https://www.epicurious.com/"), S("https://www.seriouseats.com/"),
  S("https://www.bonappetit.com/"), S("https://www.simplyrecipes.com/"), S("https://food52.com/"),
  S("https://www.thekitchn.com/"), S("https://www.budgetbytes.com/"), S("https://www.eatingwell.com/"),
  S("https://www.tasteofhome.com/"), S("https://www.kingarthurbaking.com/"),
  // ---- health ----
  S("https://www.webmd.com/fitness-exercise/default.htm"), S("https://www.healthline.com/"),
  S("https://www.mayoclinic.org/"), S("https://www.medicalnewstoday.com/"), S("https://www.everydayhealth.com/"),
  S("https://www.verywellhealth.com/"), S("https://www.prevention.com/"), S("https://www.self.com/"),
  S("https://www.menshealth.com/"), S("https://www.womenshealthmag.com/"), S("https://www.health.com/"),
  // ---- finance / business ----
  S("https://finance.yahoo.com/"), S("https://www.marketwatch.com/"), S("https://www.cnbc.com/"),
  S("https://www.forbes.com/"), S("https://www.fool.com/"), S("https://www.investopedia.com/"),
  S("https://www.kiplinger.com/"), S("https://www.nerdwallet.com/"), S("https://www.bankrate.com/"),
  S("https://www.businessinsider.com/"), S("https://www.thestreet.com/"), S("https://www.morningstar.com/"),
  // ---- lifestyle / home / travel / auto ----
  S("https://www.apartmenttherapy.com/"), S("https://www.hgtv.com/"), S("https://www.realsimple.com/"),
  S("https://www.thespruce.com/"), S("https://www.goodhousekeeping.com/"), S("https://www.countryliving.com/"),
  S("https://www.tripadvisor.com/"), S("https://www.lonelyplanet.com/"), S("https://www.travelandleisure.com/"),
  S("https://thepointsguy.com/"), S("https://www.motortrend.com/"), S("https://www.caranddriver.com/"),
  S("https://jalopnik.com/"), S("https://www.autoblog.com/"), S("https://www.edmunds.com/"),
  S("https://www.kbb.com/"), S("https://www.cars.com/"), S("https://www.zillow.com/"),
  S("https://www.realtor.com/"), S("https://www.apartments.com/"), S("https://www.yelp.com/"),
  // ---- science / education / reference ----
  S("https://www.livescience.com/"), S("https://www.sciencedaily.com/"), S("https://www.space.com/"),
  S("https://www.howstuffworks.com/"), S("https://www.smithsonianmag.com/"), S("https://www.nationalgeographic.com/"),
  S("https://www.britannica.com/"), S("https://www.wikihow.com/Main-Page"), S("https://www.dictionary.com/"),
  S("https://www.thesaurus.com/"), S("https://www.merriam-webster.com/"), S("https://www.mentalfloss.com/"),
  // ---- fandom / wikis (very ad-heavy) ----
  S("https://www.fandom.com/"), S("https://harrypotter.fandom.com/wiki/Harry_Potter"),
  S("https://minecraft.fandom.com/wiki/Minecraft_Wiki"), S("https://marvel.fandom.com/wiki/Marvel_Database"),
  S("https://www.goodreads.com/"), S("https://www.imdb.com/"),
  // ---- meme / viral / lists ----
  S("https://9gag.com/"), S("https://www.boredpanda.com/"), S("https://www.ranker.com/"),
  S("https://www.cracked.com/"), S("https://thechive.com/"), S("https://www.distractify.com/"),
  S("https://www.buzzfeednews.com/"), S("https://www.upworthy.com/"),
  // ---- forums / community ----
  S("https://old.reddit.com/r/pics/"), S("https://old.reddit.com/r/news/"), S("https://www.quora.com/"),
  S("https://stackoverflow.com/questions", { z: 1 }), S("https://news.ycombinator.com/", { z: 1 }),
  S("https://www.resetera.com/"), S("https://forums.tomshardware.com/"), S("https://www.reddit.com/r/gadgets/"),
  // ---- free tools (heavy ads) ----
  S("https://www.calculator.net/"), S("https://smallpdf.com/"), S("https://www.ilovepdf.com/"),
  S("https://tools.pdf24.org/en/"), S("https://www.online-convert.com/"), S("https://www.speedtest.net/"),
  S("https://tinypng.com/"), S("https://www.wordreference.com/"), S("https://weather.com/"),
  S("https://www.accuweather.com/"), S("https://www.wunderground.com/"), S("https://www.timeanddate.com/"),
  // ---- gaming portals (heavy ads) ----
  S("https://www.miniclip.com/games/en/"), S("https://www.kongregate.com/"), S("https://armorgames.com/"),
  S("https://www.crazygames.com/"), S("https://poki.com/"), S("https://www.addictinggames.com/"),
  S("https://www.coolmathgames.com/"), S("https://www.y8.com/"), S("https://www.agame.com/"),
  // ---- downloads ----
  S("https://download.cnet.com/"), S("https://filehippo.com/"), S("https://en.softonic.com/"),
  S("https://sourceforge.net/"), S("https://www.majorgeeks.com/"),
  // ---- lyrics ----
  S("https://genius.com/"), S("https://www.azlyrics.com/"), S("https://www.lyrics.com/"),
  S("https://www.songlyrics.com/"), S("https://www.lyricsfreak.com/"),
  // ---- coupons / deals / classifieds ----
  S("https://www.retailmenot.com/"), S("https://www.groupon.com/"), S("https://slickdeals.net/"),
  S("https://www.dealnews.com/"), S("https://www.indeed.com/"), S("https://www.glassdoor.com/"),
  // ---- photo / image ----
  S("https://imgur.com/"), S("https://www.flickr.com/explore"), S("https://www.pinterest.com/"),
  S("https://www.deviantart.com/"), S("https://unsplash.com/", { z: 1 }), S("https://www.pexels.com/", { z: 1 }),
  // ---- video / streaming (ad path) ----
  S("https://www.youtube.com/watch?v=aqz-KE-bpKQ", { v: 1 }), S("https://www.dailymotion.com/video/x8abcde", { v: 1 }),
  S("https://www.usatoday.com/media/latest/videos/", { v: 1 }), S("https://weather.com/video", { v: 1 }),
  S("https://www.aljazeera.com/live/", { v: 1 }), S("https://tubitv.com/", { v: 1 }),
  S("https://pluto.tv/en/live-tv", { v: 1 }), S("https://rumble.com/", { v: 1 }),
  S("https://www.vimeo.com/watch", { v: 1 }), S("https://www.cbsnews.com/video/", { v: 1 }),
  S("https://www.nbcnews.com/video", { v: 1 }), S("https://abcnews.go.com/Video", { v: 1 }),
  S("https://www.foxnews.com/video", { v: 1 }), S("https://www.bloomberg.com/live", { v: 1 }),
  S("https://www.twitch.tv/", { v: 1 }), S("https://www.cnn.com/videos", { v: 1 }),
  S("https://www.reuters.com/video/", { v: 1 }), S("https://www.euronews.com/live", { v: 1 }),
  // ---- FP-STRESS: image-heavy / visually ad-adjacent content (added Iter 2) ----
  // photography / stock / art / portfolio
  S("https://500px.com/popular"), S("https://www.artstation.com/"), S("https://www.behance.net/"),
  S("https://dribbble.com/shots"), S("https://www.deviantart.com/whats-hot"), S("https://www.pixiv.net/en/"),
  S("https://www.saatchiart.com/paintings"), S("https://www.gettyimages.com/photos/nature"),
  S("https://www.shutterstock.com/search/food"), S("https://www.istockphoto.com/photos/people"),
  S("https://stock.adobe.com/search?k=travel"), S("https://www.eyeem.com/"), S("https://www.designspiration.com/"),
  // real estate / cars (photo grids at ad-ish sizes)
  S("https://www.redfin.com/city/30749/CA/San-Francisco"), S("https://www.trulia.com/CA/San_Francisco/"),
  S("https://www.autotrader.com/cars-for-sale/all-cars"), S("https://www.cargurus.com/Cars/inventorylisting/viewDetailsFilterViewInventoryListing.action"),
  S("https://www.carmax.com/cars"),
  // product catalogs (image grids)
  S("https://www.overstock.com/"), S("https://www.crateandbarrel.com/furniture/sofas/1"),
  S("https://www.cb2.com/furniture/sofas/1"), S("https://www.westelm.com/shop/furniture/all-sofas/"),
  S("https://www.anthropologie.com/dresses"), S("https://www.zara.com/us/"), S("https://www2.hm.com/en_us/women.html"),
  S("https://www.asos.com/us/women/"), S("https://www.wish.com/"),
  // fashion / model shoots (portrait imagery, ad-like)
  S("https://www.vogue.com/"), S("https://www.gq.com/"), S("https://www.elle.com/"),
  S("https://www.harpersbazaar.com/"), S("https://www.cosmopolitan.com/"), S("https://www.instyle.com/"),
  S("https://www.whowhatwear.com/"), S("https://www.refinery29.com/en-us"), S("https://www.popsugar.com/"),
  // comics / webtoons / illustration
  S("https://www.webtoons.com/en/"), S("https://tapas.io/"), S("https://www.gocomics.com/"),
  S("https://xkcd.com/", { z: 1 }), S("https://explosm.net/"),
  // infographic / listicle / gallery-heavy
  S("https://www.buzzfeed.com/quizzes"), S("https://www.demilked.com/"), S("https://mymodernmet.com/"),
  S("https://www.thisiscolossal.com/"), S("https://petapixel.com/"), S("https://www.dpreview.com/"),
  S("https://www.reddit.com/r/EarthPorn/"), S("https://www.reddit.com/r/food/"), S("https://imgflip.com/"),
  S("https://knowyourmeme.com/"), S("https://www.pixiv.net/", { z: 0 }),

  // ---- clean controls ----
  S("https://example.com/", { z: 1 }), S("https://en.wikipedia.org/wiki/Main_Page", { z: 1 }),
  S("https://en.wikipedia.org/wiki/Advertising"), S("https://github.com/trending", { z: 1 }),
  S("https://www.wikipedia.org/", { z: 1 }), S("https://www.mozilla.org/en-US/", { z: 1 }),
];
