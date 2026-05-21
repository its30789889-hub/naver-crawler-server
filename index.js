const express = require('express')
const { chromium } = require('playwright')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3001

// URL에서 Place ID 추출
function extractPlaceId(url) {
  const match1 = url.match(/place\/(\d+)/)
  if (match1) return match1[1]
  const match2 = url.match(/[?&]id=(\d+)/)
  if (match2) return match2[1]
  return null
}

// naver.me 단축 URL 확장
async function expandNaverUrl(shortUrl) {
  try {
    const response = await fetch(shortUrl, {
      method: 'HEAD',
      redirect: 'follow',
    })
    return response.url
  } catch {
    return shortUrl
  }
}

// 랜덤 딜레이
function randomDelay(min = 800, max = 2000) {
  const ms = Math.floor(Math.random() * (max - min) + min)
  return new Promise((r) => setTimeout(r, ms))
}

// 리뷰 크롤링
async function crawlNaverPlace(placeUrl, maxReviews = 50) {
  let browser = null
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    })

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    })

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })

    const page = await context.newPage()
    await page.goto(placeUrl, { waitUntil: 'networkidle', timeout: 30000 })
    await randomDelay()

    // 기본 정보 추출
    const info = await page.evaluate(() => {
      const getText = (selector) =>
        document.querySelector(selector)?.textContent?.trim() ?? ''

      return {
        name: getText('h1.place_section_header_title') || getText('.place_bluelink') || getText('title')?.replace(' : 네이버 지도', '') || '가게 이름',
        category: getText('.lnJFt') || getText('.DJJvD') || '',
        address: getText('.LDgIH') || '',
        phone: getText('.xlx7Q') || '',
        hours: getText('.y6tNq') || '',
        rating: getText('.PXMot.LXIwF') || '',
      }
    })

    // 리뷰 탭 클릭
    try {
      const reviewTab = page.locator('a:has-text("리뷰"), button:has-text("리뷰")')
      if (await reviewTab.count() > 0) {
        await reviewTab.first().click()
        await randomDelay(1000, 2000)
      }
    } catch {}

    // 리뷰 수집
    const reviews = []
    let previousCount = 0

    for (let attempt = 0; attempt < 10; attempt++) {
      const newReviews = await page.evaluate(() => {
        const selectors = ['.pui__vn15t2', '.YeINN', '[class*="reviewText"]']
        const texts = []
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach((el) => {
            const text = el.textContent?.trim()
            if (text && text.length > 10 && !texts.includes(text)) texts.push(text)
          })
        }
        return texts
      })

      for (const r of newReviews) {
        if (!reviews.includes(r)) reviews.push(r)
      }

      if (reviews.length >= maxReviews || reviews.length === previousCount) break
      previousCount = reviews.length

      const moreBtn = page.locator('a:has-text("더보기"), button:has-text("더보기")')
      if (await moreBtn.count() > 0) {
        await moreBtn.first().click()
        await randomDelay(1200, 2500)
      } else {
        await page.mouse.wheel(0, 800)
        await randomDelay(800, 1500)
      }
    }

    return { ...info, reviews: reviews.slice(0, maxReviews) }
  } finally {
    if (browser) await browser.close()
  }
}

// 헬스체크
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '네이버 리뷰 크롤러 서버' })
})

// 크롤링 API
app.post('/crawl', async (req, res) => {
  try {
    let { url, maxReviews = 50 } = req.body

    if (!url) {
      return res.status(400).json({ error: 'URL을 입력해주세요' })
    }

    const isNaverUrl = url.includes('map.naver.com') || url.includes('naver.me') || url.includes('place.naver.com')
    if (!isNaverUrl) {
      return res.status(400).json({ error: '네이버 지도 URL만 지원합니다' })
    }

    // 단축 URL 확장
    if (url.includes('naver.me/')) {
      const expanded = await expandNaverUrl(url)
      console.log(`단축 URL 확장: ${url} → ${expanded}`)
      url = expanded
    }

    const placeId = extractPlaceId(url)
    if (!placeId) {
      return res.status(400).json({ error: 'URL에서 가게 ID를 찾을 수 없습니다' })
    }

    console.log(`크롤링 시작: placeId=${placeId}`)
    const startTime = Date.now()
    const result = await crawlNaverPlace(url, Math.min(maxReviews, 100))
    console.log(`크롤링 완료: ${result.reviews.length}개 리뷰, ${Date.now() - startTime}ms`)

    res.json({
      success: true,
      placeId,
      data: {
        name: result.name,
        category: result.category,
        address: result.address,
        phone: result.phone,
        hours: result.hours,
        rating: result.rating,
        reviewCount: result.reviews.length,
        reviews: result.reviews,
        reviewsText: result.reviews.join('\n'),
      },
    })
  } catch (err) {
    console.error('크롤링 오류:', err)
    res.status(500).json({ error: '크롤링 중 오류: ' + err.message })
  }
})

app.listen(PORT, () => {
  console.log(`크롤러 서버 실행 중: http://localhost:${PORT}`)
})
