const express = require('express')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3001

function extractPlaceId(url) {
  const match = url.match(/place\/(\d+)/)
  if (match) return match[1]
  const match2 = url.match(/[?&]id=(\d+)/)
  if (match2) return match2[1]
  return null
}

async function expandNaverUrl(shortUrl) {
  try {
    const res = await fetch(shortUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
      }
    })
    return res.url
  } catch (e) {
    console.log('단축URL 확장 실패:', e.message)
    return shortUrl
  }
}

async function fetchReviews(placeId, maxReviews = 50) {
  const reviews = []

  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Referer': `https://pcmap.place.naver.com/restaurant/${placeId}/review/visitor`,
    'Content-Type': 'application/json',
  }

  for (let page = 1; page <= 5 && reviews.length < maxReviews; page++) {
    try {
      const body = [{
        operationName: 'getVisitorReviews',
        variables: {
          input: {
            businessId: placeId,
            businessType: 'restaurant',
            item: '0',
            bookingBusinessId: null,
            page,
            size: 10,
            isPhotoUsed: false,
            includeSuper: true,
            getUserStats: true,
            includeRank: true,
            cidList: [],
          }
        },
        query: `query getVisitorReviews($input: VisitorReviewsInput) {
          visitorReviews(input: $input) {
            items { id body rating author { nickname } }
            totalCount
          }
        }`
      }]

      console.log(`[리뷰] 페이지 ${page} 요청 중...`)

      const res = await fetch('https://pcmap-api.place.naver.com/place/graphql', {
        method: 'POST',
        headers: commonHeaders,
        body: JSON.stringify(body),
      })

      console.log(`[리뷰] 응답 상태: ${res.status}`)

      const text = await res.text()
      console.log(`[리뷰] 응답 내용 (첫 200자): ${text.slice(0, 200)}`)

      if (!res.ok) break

      const data = JSON.parse(text)
      const items = data?.[0]?.data?.visitorReviews?.items || []
      console.log(`[리뷰] 페이지 ${page}: ${items.length}개`)

      if (items.length === 0) break

      for (const item of items) {
        if (item.body?.trim()) reviews.push(item.body.trim())
      }

      await new Promise(r => setTimeout(r, 500))
    } catch (err) {
      console.error(`[리뷰] 페이지 ${page} 오류:`, err.message)
      break
    }
  }

  return reviews.slice(0, maxReviews)
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '네이버 리뷰 크롤러 서버 v4' })
})

app.post('/crawl', async (req, res) => {
  try {
    let { url, maxReviews = 50 } = req.body

    if (!url) return res.status(400).json({ error: 'URL을 입력해주세요' })

    const isNaverUrl = url.includes('map.naver.com') || url.includes('naver.me') || url.includes('place.naver.com')
    if (!isNaverUrl) return res.status(400).json({ error: '네이버 지도 URL만 지원합니다' })

    if (url.includes('naver.me/')) {
      url = await expandNaverUrl(url)
      console.log(`단축 URL 확장 결과: ${url}`)
    }

    const placeId = extractPlaceId(url)
    console.log(`placeId 추출: ${placeId} (from: ${url})`)

    if (!placeId) return res.status(400).json({ error: 'URL에서 가게 ID를 찾을 수 없습니다' })

    const reviews = await fetchReviews(placeId, Math.min(maxReviews, 50))
    console.log(`최종 리뷰 수: ${reviews.length}`)

    res.json({
      success: true,
      placeId,
      data: {
        name: '가게 이름',
        category: '',
        address: '',
        phone: '',
        hours: '',
        rating: '',
        reviewCount: reviews.length,
        reviews,
        reviewsText: reviews.join('\n'),
      },
    })
  } catch (err) {
    console.error('오류:', err)
    res.status(500).json({ error: '처리 중 오류: ' + err.message })
  }
})

// 네이버 블로그 크롤러
async function fetchBlogContent(blogUrl) {
  try {
    // 모바일 버전으로 변환 (파싱 쉬움)
    const mobileUrl = blogUrl
      .replace('blog.naver.com', 'm.blog.naver.com')

    const res = await fetch(mobileUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      }
    })

    const html = await res.text()

    // 텍스트 추출
    const textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000)

    // 이미지 URL 추출
    const imgMatches = html.match(/https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*/gi) || []
    const images = [...new Set(imgMatches)]
      .filter(url => url.includes('blogfiles') || url.includes('postfiles'))
      .slice(0, 5)

    return { textContent, images }
  } catch (err) {
    console.error('[블로그] 크롤링 오류:', err.message)
    throw err
  }
}

app.post('/crawl-blog', async (req, res) => {
  try {
    const { url } = req.body

    if (!url) return res.status(400).json({ error: 'URL을 입력해주세요' })

    const isBlogUrl = url.includes('blog.naver.com')
    if (!isBlogUrl) return res.status(400).json({ error: '네이버 블로그 URL만 지원합니다' })

    console.log(`[블로그] 크롤링 시작: ${url}`)

    const { textContent, images } = await fetchBlogContent(url)

    console.log(`[블로그] 텍스트 ${textContent.length}자, 이미지 ${images.length}개 추출`)

    res.json({
      success: true,
      data: {
        textContent,
        images,
      }
    })
  } catch (err) {
    console.error('[블로그] 오류:', err)
    res.status(500).json({ error: '처리 중 오류: ' + err.message })
  }
})
app.listen(PORT, () => {
  console.log(`크롤러 서버 v4 실행 중: http://localhost:${PORT}`)
})
