const axios = require('axios');

const PC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Mock browser globals needed by renderHome
const document = {
  getElementById: (id) => {
    console.log(`[MOCK DOM] getElementById: ${id}`);
    return {
      innerHTML: '',
      appendChild: (el) => console.log(`[MOCK DOM] appended element to ${id}`),
      querySelectorAll: (sel) => {
        console.log(`[MOCK DOM] querySelectorAll ${sel}`);
        return [{ getAttribute: () => 'logout', addEventListener: () => {} }];
      }
    };
  },
  createElement: (tag) => {
    console.log(`[MOCK DOM] createElement: ${tag}`);
    return {
      style: {},
      appendChild: (el) => console.log(`[MOCK DOM] appended to created element`),
      addEventListener: () => {}
    };
  },
  querySelectorAll: (sel) => {
    console.log(`[MOCK DOM] querySelectorAll ${sel}`);
    return [];
  }
};

const Api = {
  getProxyUrl: () => 'http://mock-proxy'
};

function findImage(images, type) {
    if (!images || !images.length) return null;
    for (var i = 0; i < images.length; i++) {
        if (images[i].imageType === type) {
            return images[i];
        }
    }
    return images[0];
}

async function test() {
  try {
    const mainPage = await axios.get('https://www.tabii.com/tr', { headers: { 'User-Agent': PC_USER_AGENT } });
    const html = mainPage.data;
    const match = html.match(/"buildId"\s*:\s*"([^"]+)"/);
    const buildId = match[1];
    const url = `https://www.tabii.com/_next/data/${buildId}/tr.json`;
    const response = await axios.get(url, { headers: { 'User-Agent': PC_USER_AGENT, 'Accept': 'application/json' } });
    const homeData = response.data.pageProps.data;

    console.log('\n--- MOCK RUN OF renderHome() ---');
    
    // REPLICATE RENDERHOME
    var content = document.getElementById('home-content');
    content.innerHTML = '';

    // Render dynamic Carousel (Hero Banner) on top
    if (homeData.carousel && homeData.carousel[0] && homeData.carousel[0].items) {
        var hero = homeData.carousel[0].items[0];
        var heroImg = '';
        if (hero.images) {
            var imgObj = findImage(hero.images, 'horizontal');
            if (imgObj) heroImg = imgObj.name;
        }
        if (heroImg) {
            heroImg = Api.getProxyUrl() + '/_proxy/image/' + heroImg;
        }

        var banner = document.createElement('div');
        banner.className = 'hero-banner';
        banner.style.backgroundImage = "url('" + heroImg + "')";

        banner.innerHTML = '<div class="hero-overlay">' +
            '<h1 class="hero-title">' + (hero.title || 'tabii') + '</h1>' +
            '<div class="hero-desc">' + (hero.description || '') + '</div>' +
            '</div>';
        content.appendChild(banner);
    }

    // Render Canlı Yayınlar (Live channels)
    if (homeData.liveStreamPromoter && homeData.liveStreamPromoter[0]) {
        var section = homeData.liveStreamPromoter[0];
        createRow(content, section.title, section.items, true);
    }

    // Render other promoter rows
    if (homeData.promoter) {
        homeData.promoter.forEach(function (sec) {
            if (sec.items && sec.items.length > 0) {
                createRow(content, sec.title, sec.items, false);
            }
        });
    }

    // Sidebar click handlers
    var sidebarMenu = document.getElementById('sidebar-menu');
    var navItems = sidebarMenu.querySelectorAll('.nav-item');
    Array.prototype.slice.call(navItems).forEach(function (item) {
        // dummy check
    });

    console.log('--- MOCK RUN COMPLETED SUCCESS ---');

    function createRow(container, title, items, isLive) {
        var row = document.createElement('div');
        row.className = 'content-row';
        row.innerHTML = '<h3 class="row-title">' + title + '</h3>';

        var cardContainer = document.createElement('div');
        cardContainer.className = 'row-cards';

        items.forEach(function (item) {
            var imgName = '';
            if (item.images) {
                var imgType = isLive ? 'mainWithLogo' : 'vertical';
                var imgObj = findImage(item.images, imgType);
                if (imgObj) imgName = imgObj.name;
            }
            var cardImg = imgName ? Api.getProxyUrl() + '/_proxy/image/' + imgName : '';

            var card = document.createElement('div');
            card.className = 'card-item focusable' + (isLive ? ' live-card' : '');
            card.innerHTML = '<img class="card-poster" src="' + cardImg + '" onerror="this.src=\'icon.png\'">' +
                '<div class="card-title">' + item.title + '</div>';

            cardContainer.appendChild(card);
        });

        row.appendChild(cardContainer);
        container.appendChild(row);
    }

  } catch (err) {
    console.error('Error during mock run:', err.stack);
  }
}

test();
