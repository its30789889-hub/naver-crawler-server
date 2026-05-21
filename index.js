const express = require('express')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3001

// URL에서 Place ID 추출
function extractPlaceId(url) {
  // map.naver.com/v5/entry/place/123456789
  const match1 = url.match(/place\/(\d+)/)
  if (match1) return match1[1]

  // query string
  const match2 = url.match(/[?&]id=(\d+)/)
  if (match2) return match2[2]

  return null
}

// naver.me 단축 URL 확장
async function expandNaverUrl(shortUrl) {
  try {
    const response = await fetch(shortUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
      }
    })
    return response.url
  } catch {
    return shortUrl
  }
}

// 네이버 플레이스 내부 API로 리뷰 가져오기
async function fetchNaverPlaceReviews(placeId, maxReviews = 50) {
  const reviews = []
  let start = 1
  const pageSize = 10

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Referer': `https://pcmap.place.naver.com/restaurant/${placeId}/review/visitor`,
    'Origin': 'https://pcmap.place.naver.com',
  }

  while (reviews.length < maxReviews) {
    try {
      // 네이버 플레이스 방문자 리뷰 API
      const url = `https://api.place.naver.com/graphql`
      const query = {
        operationName: 'getVisitorReviews',
        variables: {
          input: {
            businessId: placeId,
            businessType: 'restaurant',
            item: '0',
            bookingBusinessId: null,
            page: Math.ceil(start / pageSize),
            size: pageSize,
            isPhotoUsed: false,
            includeSuper: true,
            getUserStats: true,
            includeRank: true,
            cidList: [],
          }
        },
        query: `query getVisitorReviews($input: VisitorReviewsInput) {
          visitorReviews(input: $input) {
            items {
              id
              body
              rating
              author { nickname }
            }
            totalCount
          }
        }`
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
      })

      if (!res.ok) break

      const data = await res.json()
      const items = data?.data?.visitorReviews?.items || []

      if (items.length === 0) break

      for (const item of items) {
        if (item.body && item.body.trim().length > 5) {
          reviews.push(item.body.trim())
        }
      }

      start += pageSize
      if (items.length < pageSize) break

      // 짧은 딜레이
      await new Promise(r => setTimeout(r, 300))
    } catch (err) {
      console.error('리뷰 페이지 오류:', err.message)
      break
    }
  }

  return reviews.slice(0, maxReviews)
}

// 네이버 플레이스 기본 정보 가져오기
async function fetchNaverPlaceInfo(placeId) {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': `https://pcmap.place.naver.com/restaurant/${placeId}/home`,
    }

    const url = `https://api.place.naver.com/graphql`
    const query = {
      operationName: 'getBookingBusiness',
      variables: { input: { businessId: placeId } },
      query: `query getBookingBusiness($input: BusinessInput) {
        business(input: $input) {
          name
          category
          address
          phone
          businessHours { description }
          rating { ratingAvg }
        }
      }`
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
    })

    if (!res.ok) return null

    const data = await res.json()
    return data?.data?.business || null
  } catch {
    return null
  }
}

// 헬스체크
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '네이버 리뷰 크롤러 서버 v2' })
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
      url = await expandNaverUrl(url)
      console.log(`단축 URL 확장: ${url}`)
    }

    const placeId = extractPlaceId(url)
    if (!placeId) {
      return res.status(400).json({ error: 'URL에서 가게 ID를 찾을 수 없습니다' })
    }

    console.log(`리뷰 수집 시작: placeId=${placeId}`)
    const startTime = Date.now()

    // 병렬로 기본 정보 + 리뷰 가져오기
    const [info, reviews] = await Promise.all([
      fetchNaverPlaceInfo(placeId),
      fetchNaverPlaceReviews(placeId, Math.min(maxReviews, 100)),
    ])

    console.log(`완료: ${reviews.length}개 리뷰, ${Date.now() - startTime}ms`)

    res.json({
      success: true,
      placeId,
      data: {
        name: info?.name || '가게 이름',
        category: info?.category || '',
        address: info?.address || '',
        phone: info?.phone || '',
        hours: info?.businessHours?.description || '',
        rating: String(info?.rating?.ratingAvg || ''),
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

app.listen(PORT, () => {
  console.log(`크롤러 서버 v2 실행 중: http://localhost:${PORT}`)
})
